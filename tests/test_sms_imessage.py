"""Tests for the OTP extraction logic in ``src/sms_imessage.py``.

These tests exercise the pure functions only — no SQLite, no network, no
macOS dependency. The fixtures under ``tests/fixtures/sms_attributedbody``
are hex-encoded snapshots of the ``message.attributedBody`` blob from the
operator's macOS Messages DB captured on 2026-05-20.
"""

from __future__ import annotations

import re

import pytest

import sqlite3

from sms_imessage import (
    OTP_KEYWORDS,
    checkpoint_wal,
    extract_code_from_row,
    extract_printable_runs,
)
from tests.conftest import FIXTURES


CODE_REGEX = re.compile(r"\b(\d{6})\b")


def load_blob(name: str) -> bytes:
    """Load a hex-encoded fixture as raw bytes."""
    return bytes.fromhex((FIXTURES / name).read_text().strip())


# ---------------------------------------------------------------------------
# extract_code_from_row — the main acceptance criteria
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture_name,expected_code",
    [
        # text=NULL on the live DB row; code lives only in the blob.
        ("2026-05-20T06-00-08_uscis_145950.hex", "145950"),
        ("2026-05-20T12-05-30_uscis_983284.hex", "983284"),
    ],
)
def test_extracts_code_when_text_is_null(fixture_name: str, expected_code: str) -> None:
    blob = load_blob(fixture_name)
    code = extract_code_from_row(None, blob, CODE_REGEX)
    assert code == expected_code


def test_extracts_code_when_text_is_populated() -> None:
    """Regression: when m.text is populated (macOS <13 fast path / lucky
    macOS 13+ row), we still pull the same code and don't double-extract."""
    blob = load_blob("2026-05-20T19-22-42_uscis_447431.hex")
    text = (
        "447431 is the secure verification code for logging into your "
        "USCIS Online Account."
    )
    code = extract_code_from_row(text, blob, CODE_REGEX)
    assert code == "447431"


def test_returns_none_for_non_uscis_message() -> None:
    """Negative: an apartment-renewal SMS contains no OTP keyword and must
    not surface a code even though the blob contains digit sequences (a
    date like ``09/30/2026``). The keyword gate is what protects us from
    extracting bogus codes from unrelated messages."""
    blob = load_blob("2026-05-20T11-57-58_apartment_NEGATIVE.hex")
    assert extract_code_from_row(None, blob, CODE_REGEX) is None


# ---------------------------------------------------------------------------
# extract_printable_runs — helper-level coverage
# ---------------------------------------------------------------------------


def test_printable_runs_empty_inputs() -> None:
    assert extract_printable_runs(None) == ""
    assert extract_printable_runs(b"") == ""


def test_printable_runs_drops_short_noise() -> None:
    # b"\x00abc\x00DEFG\x00" => "abc" is dropped (len 3 < min_run=4),
    # "DEFG" is kept.
    assert extract_printable_runs(b"\x00abc\x00DEFG\x00") == "DEFG"


def test_printable_runs_recovers_full_uscis_text() -> None:
    blob = load_blob("2026-05-20T06-00-08_uscis_145950.hex")
    recovered = extract_printable_runs(blob)
    # Sanity: the literal SMS body is recoverable from the blob.
    assert "145950 is the secure verification code" in recovered
    assert "USCIS Online Account" in recovered


# ---------------------------------------------------------------------------
# OTP_KEYWORDS shape — guard against accidental mutation
# ---------------------------------------------------------------------------


def test_keywords_are_lowercase_tuple() -> None:
    assert isinstance(OTP_KEYWORDS, tuple)
    assert all(kw == kw.lower() for kw in OTP_KEYWORDS)
    assert "verification" in OTP_KEYWORDS
    assert "uscis" in OTP_KEYWORDS


# ---------------------------------------------------------------------------
# checkpoint_wal — TRUNCATE-first, PASSIVE fallback, never raises
# ---------------------------------------------------------------------------


class _FakeResult:
    """Stand-in for the cursor object ``Cursor.execute`` returns; supports the
    ``.fetchone()`` checkpoint_wal calls to read the ``(busy, log, ckpt)`` row."""

    def __init__(self, row) -> None:
        self._row = row

    def fetchone(self):
        return self._row


# A successful checkpoint returns (busy=0, log, checkpointed); a contended one
# returns (busy=1, -1, -1) WITHOUT raising.
_OK_ROW = (0, 5, 5)
_BUSY_ROW = (1, -1, -1)


class _FakeCursor:
    """Records the checkpoint PRAGMAs executed. ``fail_modes`` makes a mode
    raise ``OperationalError``; ``busy_modes`` makes a mode return a busy
    result row (busy==1) instead of raising — the contention path that the
    earlier OperationalError-only handler silently skipped."""

    def __init__(
        self,
        fail_modes: tuple[str, ...] = (),
        busy_modes: tuple[str, ...] = (),
    ) -> None:
        self.calls: list[str] = []
        self._fail_modes = fail_modes
        self._busy_modes = busy_modes

    def execute(self, sql: str) -> _FakeResult:
        self.calls.append(sql)
        # busy_timeout read returns the current value; set/restore are no-ops.
        if "busy_timeout" in sql:
            if "=" in sql:
                return _FakeResult(None)
            return _FakeResult((5000,))
        for mode in self._fail_modes:
            if mode in sql:
                raise sqlite3.OperationalError(f"database is locked ({mode})")
        for mode in self._busy_modes:
            if mode in sql:
                return _FakeResult(_BUSY_ROW)
        return _FakeResult(_OK_ROW)


def _checkpoint_calls(cur: "_FakeCursor") -> list[str]:
    return [c for c in cur.calls if "wal_checkpoint" in c]


def test_checkpoint_truncate_succeeds_no_fallback() -> None:
    cur = _FakeCursor()
    checkpoint_wal(cur)
    ckpts = _checkpoint_calls(cur)
    assert len(ckpts) == 1
    assert "TRUNCATE" in ckpts[0]


def test_checkpoint_zeroes_then_restores_busy_timeout() -> None:
    # Regression (codex P2): the checkpoints must run non-blocking. Verify the
    # busy timeout is set to 0 before the checkpoint and restored afterwards so
    # a contended checkpoint returns immediately instead of stalling the poll.
    cur = _FakeCursor()
    checkpoint_wal(cur)
    assert "PRAGMA busy_timeout=0;" in cur.calls
    # The zero must come before the TRUNCATE checkpoint.
    assert cur.calls.index("PRAGMA busy_timeout=0;") < cur.calls.index(
        next(c for c in cur.calls if "TRUNCATE" in c)
    )
    # And the prior value (5000) is restored after.
    assert "PRAGMA busy_timeout=5000;" in cur.calls
    assert cur.calls.index("PRAGMA busy_timeout=5000;") > cur.calls.index(
        next(c for c in cur.calls if "TRUNCATE" in c)
    )


def test_checkpoint_falls_back_to_passive_on_truncate_error() -> None:
    cur = _FakeCursor(fail_modes=("TRUNCATE",))
    # Must not raise: TRUNCATE fails, PASSIVE is attempted as the fallback.
    checkpoint_wal(cur)
    assert any("TRUNCATE" in c for c in cur.calls)
    assert any("PASSIVE" in c for c in cur.calls)


def test_checkpoint_falls_back_to_passive_on_truncate_busy_row() -> None:
    # Regression (codex P2): a busy TRUNCATE returns (busy=1, ...) WITHOUT
    # raising. The PASSIVE fallback must still fire — this is exactly the
    # contention case the helper exists for.
    cur = _FakeCursor(busy_modes=("TRUNCATE",))
    checkpoint_wal(cur)
    assert any("TRUNCATE" in c for c in cur.calls)
    assert any("PASSIVE" in c for c in cur.calls)


def test_checkpoint_no_fallback_when_truncate_not_busy() -> None:
    # A clean TRUNCATE (busy=0) must NOT trigger a redundant PASSIVE call.
    cur = _FakeCursor()
    checkpoint_wal(cur)
    assert not any("PASSIVE" in c for c in cur.calls)


def test_checkpoint_swallows_passive_error_too() -> None:
    # Both modes fail (e.g. WAL not enabled): checkpoint_wal must still not
    # raise — it is best-effort and must never block the poll.
    cur = _FakeCursor(fail_modes=("TRUNCATE", "PASSIVE"))
    checkpoint_wal(cur)
    assert any("TRUNCATE" in c for c in cur.calls)
    assert any("PASSIVE" in c for c in cur.calls)


def test_checkpoint_busy_truncate_then_busy_passive_no_raise() -> None:
    # Both checkpoints return busy rows (no exceptions): must not raise and
    # must have attempted both — PASSIVE is the best-effort floor.
    cur = _FakeCursor(busy_modes=("TRUNCATE", "PASSIVE"))
    checkpoint_wal(cur)
    assert any("TRUNCATE" in c for c in cur.calls)
    assert any("PASSIVE" in c for c in cur.calls)
