#!/usr/bin/env python3
"""Poll macOS Messages (iMessage) until an OTP code is found."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path


# Lowercase keywords that must appear (case-insensitive) in the message
# haystack (m.text + printable runs extracted from m.attributedBody) for a
# row to be considered an OTP carrier. Keep in sync with the SQL LIKE
# filter so DB-side and Python-side filtering surface the same row set.
OTP_KEYWORDS: tuple[str, ...] = ("verification", "uscis", "secure")


@dataclass
class MessageConfig:
    code_regex: str
    timeout_seconds: int
    poll_interval_seconds: int
    since_seconds: int


def parse_args() -> MessageConfig:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config-json", required=True)
    args = parser.parse_args()
    raw = json.loads(args.config_json)
    return MessageConfig(
        code_regex=raw.get("codeRegex", r"\b(\d{6})\b"),
        timeout_seconds=int(raw.get("timeoutSeconds", 300)),
        poll_interval_seconds=int(raw.get("pollIntervalSeconds", 2)),
        since_seconds=int(raw.get("sinceSeconds", 600)),
    )


def checkpoint_wal(cursor: sqlite3.Cursor) -> None:
    """Force pending Messages.app writes in ``chat.db-wal`` into the main DB
    so this reader's snapshot includes them. Best-effort: NEVER raises.

    Tries a ``TRUNCATE`` checkpoint first — it folds the WAL back into the
    main database and truncates the WAL file, which is the strongest pull of
    not-yet-merged rows.

    A checkpoint can fail two ways, and we must handle BOTH or the fallback is
    skipped exactly in the contention case this helper targets:
      * SQLite raises ``OperationalError`` (e.g. WAL mode not enabled).
      * ``PRAGMA wal_checkpoint`` returns a result row ``(busy, log,
        checkpointed)`` where ``busy == 1`` — TRUNCATE could not grab the
        write lock because Messages.app's writer is mid-write. This does NOT
        raise; we must inspect the row.
    On either TRUNCATE failure we fall back to a ``PASSIVE`` checkpoint, which
    never blocks the writer and folds whatever WAL pages it can. PASSIVE is
    the best-effort floor: if it too is busy or raises, we swallow it — the
    row will be picked up on a later poll once auto-checkpoint catches up.

    NON-BLOCKING: the connection is opened with ``timeout=5``, so a contended
    TRUNCATE could otherwise block up to 5s waiting for the writer lock and
    starve the ~2s poll loop. We set ``busy_timeout=0`` for the duration of the
    checkpoints so a busy checkpoint returns ``busy=1`` IMMEDIATELY instead of
    waiting, then restore the prior busy_timeout so the row SELECT keeps its
    normal wait behaviour.
    """

    def _busy(result) -> bool:
        # Row shape is (busy, log_pages, checkpointed_pages); busy==1 means
        # the checkpoint could not acquire the lock and did nothing useful.
        try:
            return bool(result and result[0] == 1)
        except (TypeError, IndexError):
            return False

    # Read & zero the busy timeout so the checkpoints never wait on the writer.
    prior_timeout_ms = None
    try:
        row = cursor.execute("PRAGMA busy_timeout;").fetchone()
        prior_timeout_ms = row[0] if row else None
        cursor.execute("PRAGMA busy_timeout=0;")
    except sqlite3.OperationalError:
        prior_timeout_ms = None

    try:
        truncate_busy = _busy(cursor.execute("PRAGMA wal_checkpoint(TRUNCATE);").fetchone())
    except sqlite3.OperationalError:
        truncate_busy = True

    if truncate_busy:
        try:
            cursor.execute("PRAGMA wal_checkpoint(PASSIVE);").fetchone()
        except sqlite3.OperationalError:
            pass

    # Restore the prior busy timeout so the subsequent row SELECT keeps its
    # normal wait behaviour. Best-effort; never raise out of this helper.
    if prior_timeout_ms is not None:
        try:
            cursor.execute(f"PRAGMA busy_timeout={int(prior_timeout_ms)};")
        except (sqlite3.OperationalError, ValueError, TypeError):
            pass


def get_messages_db_path() -> str | None:
    """Get the path to macOS Messages database."""
    db_path = Path.home() / "Library" / "Messages" / "chat.db"
    if db_path.exists():
        return str(db_path)
    return None


def extract_printable_runs(blob: bytes | None, min_run: int = 4) -> str:
    """Scan ``blob`` and join runs of printable ASCII (0x20-0x7E) of length
    >= ``min_run`` with single spaces.

    macOS 13+ stores incoming SMS bodies in ``message.attributedBody`` as a
    typedstream-encoded NSAttributedString and frequently leaves
    ``message.text`` NULL. The body text is stored verbatim as readable
    UTF-8 inside the blob; a printable-ASCII scan is sufficient to recover
    it without taking on a typedstream parser dependency.
    """
    if not blob:
        return ""
    out: list[str] = []
    run = bytearray()
    for b in blob:
        if 0x20 <= b <= 0x7E:
            run.append(b)
        else:
            if len(run) >= min_run:
                out.append(run.decode("ascii"))
            run.clear()
    if len(run) >= min_run:
        out.append(run.decode("ascii"))
    return " ".join(out)


def extract_code_from_row(
    text: str | None,
    attributed_body: bytes | None,
    code_regex: re.Pattern[str],
    keywords: tuple[str, ...] = OTP_KEYWORDS,
) -> str | None:
    """Return the OTP code from a single Messages row, or ``None``.

    Builds a combined haystack from ``text`` plus the printable-ASCII runs
    extracted from ``attributed_body``, requires at least one keyword to
    appear (case-insensitive), then runs ``code_regex`` against the
    haystack and returns the first captured group (or full match if the
    regex has no groups).
    """
    parts: list[str] = []
    if text:
        parts.append(text)
    runs = extract_printable_runs(attributed_body)
    if runs:
        parts.append(runs)
    if not parts:
        return None
    haystack = " ".join(parts)
    lowered = haystack.lower()
    if not any(kw in lowered for kw in keywords):
        return None
    matched = code_regex.search(haystack)
    if not matched:
        return None
    return matched.group(1) if matched.groups() else matched.group(0)


def poll_for_code_from_messages(config: MessageConfig) -> str:
    """Poll iMessage database for OTP code from SMS containing verification keywords."""
    db_path = get_messages_db_path()
    if not db_path:
        raise RuntimeError(
            "Messages database not found. "
            "Expected: ~/Library/Messages/chat.db"
        )

    deadline = time.time() + config.timeout_seconds
    pattern = re.compile(config.code_regex)
    
    # Calculate cutoff in nanoseconds (macOS epoch: Jan 1, 2001)
    # macOS epoch is 978307200 seconds before Unix epoch (Jan 1, 1970)
    now_unix = time.time()  # Unix timestamp
    now_macos = (now_unix - 978307200) * 1_000_000_000  # Convert to macOS nanoseconds
    cutoff_ns = int(now_macos - (config.since_seconds * 1_000_000_000))
    
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        remaining = max(0, int(deadline - time.time()))
        print(
            f"[sms-test] Poll {attempt}: checking Messages for verification codes "
            f"({remaining}s remaining)",
            file=sys.stderr,
            flush=True,
        )

        try:
            conn = sqlite3.connect(db_path, timeout=5)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()

            # Force any pending Messages.app writes in chat.db-wal to merge
            # into the main DB so this reader's snapshot includes them. The
            # default auto-checkpoint threshold (1000 pages, ~1MB) sometimes
            # lags by minutes — or hours, when imagent defers the relay write
            # on an awake Mac (see 2026-06-05 incident) — hiding fresh USCIS
            # verification SMS from us mid-poll. checkpoint_wal tries the
            # strong TRUNCATE checkpoint and falls back to PASSIVE; it never
            # blocks Messages.app's writer and never raises.
            checkpoint_wal(cursor)

            # Query messages that *might* carry an OTP. Two routes:
            #   (1) m.text LIKE keyword  — fast path on macOS <13 and on rows
            #       where iMessage still populates the text column.
            #   (2) m.attributedBody IS NOT NULL — on macOS 13+ incoming SMS
            #       frequently land with text=NULL and the body lives only in
            #       the typedstream blob. We over-select here and then apply
            #       the keyword filter in Python against the printable runs
            #       extracted from the blob (see extract_code_from_row).
            # date is macOS nanoseconds (Unix epoch + 978307200s offset).
            cursor.execute("""
                SELECT m.ROWID, m.text, m.attributedBody, m.date, m.service
                FROM message m
                WHERE m.date >= ?
                AND (
                    (m.text IS NOT NULL
                     AND (m.text LIKE '%verification%'
                          OR m.text LIKE '%secure%'
                          OR m.text LIKE '%USCIS%'))
                    OR m.attributedBody IS NOT NULL
                )
                ORDER BY m.date DESC
                LIMIT 100
            """, (cutoff_ns,))

            candidates = []
            rows = cursor.fetchall()

            if rows:
                print(
                    f"[sms-test] Found {len(rows)} candidate message(s) "
                    f"(text-keyword or attributedBody)",
                    file=sys.stderr,
                    flush=True,
                )
                for row in rows:
                    text = row["text"]
                    attributed = row["attributedBody"]
                    service = row["service"] or "unknown"

                    code = extract_code_from_row(text, attributed, pattern)
                    if code:
                        created_at = row["date"]
                        # Prefer text for the preview snippet; fall back to
                        # the first ~75 chars of the recovered printable
                        # runs so the log line stays useful when text=NULL.
                        preview = text if text else extract_printable_runs(attributed)
                        candidates.append((created_at, code, preview, service))
                        print(
                            f"[sms-test]   ✓ Found code '{code}' via {service}: "
                            f"{preview[:75]!r}",
                            file=sys.stderr,
                            flush=True,
                        )
            else:
                print(
                    f"[sms-test] No recent candidate messages "
                    f"(looked back {config.since_seconds}s)",
                    file=sys.stderr,
                    flush=True,
                )

            if candidates:
                candidates.sort(key=lambda item: item[0], reverse=True)
                _, code, _preview, _service = candidates[0]
                print(
                    f"[sms-test] ✓ Extracted code '{code}' from latest message",
                    file=sys.stderr,
                    flush=True,
                )
                print(code)
                conn.close()
                return code

            conn.close()

        except sqlite3.OperationalError as e:
            # Database might be locked if Messages app is using it
            error_msg = str(e).lower()
            if "authorization denied" in error_msg or "operation not permitted" in error_msg:
                print(
                    f"[sms-test] ❌ Full Disk Access permission required!\n"
                    f"[sms-test] Fix: System Settings > Privacy & Security > Full Disk Access\n"
                    f"[sms-test]      1. Click + and add Terminal.app or VS Code\n"
                    f"[sms-test]      2. Restart terminal/editor\n"
                    f"[sms-test]      3. Close Messages app\n"
                    f"[sms-test]      4. Try again",
                    file=sys.stderr, flush=True
                )
            else:
                print(f"[sms-test] Database error: {e}", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"[sms-test] Error querying Messages: {e}", file=sys.stderr, flush=True)

        time.sleep(config.poll_interval_seconds)

    raise TimeoutError("Timed out waiting for verification code in Messages")


def main() -> int:
    config = parse_args()
    try:
        poll_for_code_from_messages(config)
        return 0
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
