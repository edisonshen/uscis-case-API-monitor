# DESIGN: Fix WAL visibility race in OTP poll (Bug C)

**Status:** Approved 2026-05-26T01:38Z by operator.
**Author:** Coordinator (Claude Code).
**Scope:** One additional bug in the OTP read path, discovered 5 days after Bug A landed.

---

## 1. Summary

Bug A (commit `0c10492`, 2026-05-20) added `attributedBody` extraction to `src/sms_imessage.py`. It works — afternoon cron runs on May 21 and May 22 successfully extracted OTP codes from `attributedBody`-only SMS and posted case-status reports. BUT every morning run (06:00 PT) since then has failed at the OTP step, even though the USCIS verification SMS reached `chat.db`.

Today (2026-05-25) both runs failed (morning AND afternoon). Investigation confirmed:

- `chat.db` is in WAL journal mode (`PRAGMA journal_mode = wal`).
- The Python sqlite3 reader inside `sms_imessage.py` opens a fresh connection per poll, runs a SELECT, and gets 0 rows.
- The exact same SQL run by hand later (with a 24h window) returns all the messages including the ones the cron poll missed.
- Bug A's unit tests pass (they don't touch a live DB; they're pure-function tests against captured fixtures).

**Root cause:** New SMS rows live in `chat.db-wal` for some time before Messages.app checkpoints them into the main `chat.db`. During that window the Python reader's snapshot view of the DB does not include those rows. The race is intermittent — much worse at 06:00 PT when the Mac is coming out of sleep and Messages.app is cold; better in the afternoon when Messages.app is hot and checkpoints flush quickly.

## 2. Design decision

Add an **explicit WAL checkpoint** before each poll's SELECT, so the reader's snapshot includes any pending writes from Messages.app:

```python
# inside the while loop, right after sqlite3.connect():
conn.execute("PRAGMA wal_checkpoint(PASSIVE);")
```

- `PASSIVE` doesn't block writers; if Messages.app is mid-write the checkpoint silently does nothing and we still see a fresh snapshot once it commits.
- The default `auto_checkpoint` threshold (1000 pages = ~1MB) is what's failing us; forcing a per-poll checkpoint covers the gap.
- The connection is opened fresh per poll iteration today, so the snapshot also advances naturally — but the existing snapshot doesn't include uncommitted WAL pages until a checkpoint runs.

**Why not the "Defense in depth" variant?** Operator picked the minimal option. Adding `BEGIN IMMEDIATE; ROLLBACK;` to force a writer-lock wait is a heavier hammer and would introduce a contention path that's hard to test. We can revisit if the minimal fix doesn't hold.

**Why not wire `email_otp.py` as a fallback?** Same reason as the original Bug A design — explicit non-goal. Revisit if Bug C's fix doesn't fully resolve morning runs.

## 3. Task split

Single task. Trivial diff.

| Slug | Goal |
|---|---|
| `otp-wal-checkpoint` | Add `PRAGMA wal_checkpoint(PASSIVE)` to `sms_imessage.py` poll loop |

## 4. Test plan

Bug A's existing pytest cases must still pass (they don't hit a live DB). No new pure-function test is meaningful — this fix is about live-DB timing, which we can only verify by running the cron and seeing tomorrow's 06:00 PT morning run succeed.

**Smoke verification by worker:**
- Run `python3 src/sms_imessage.py --config-json '{"timeoutSeconds":2,"pollIntervalSeconds":2,"sinceSeconds":86400,"codeRegex":"\\b(\\d{6})\\b"}'` to confirm the script still extracts a code from today's SMS without error.

**Operational verification (operator, tomorrow):**
- Check `state/scheduler.log` after the 06:00 PT cron and confirm `[sms-test] Found N candidate message(s)` appears.

## 5. Assumptions

- The Python sqlite3 library and Apple's sqlite share version 3.51.0 (verified).
- The daemon was restarted at 2026-05-25T18:00 PT to pick up Bug B's `monitor.mjs` changes; no further restart needed for `sms_imessage.py` changes (Python is spawned per OTP call).
- Operator runs Messages.app actively; full-disk-access for the daemon's terminal is in place.

## 6. Non-goals

- Wiring `src/email_otp.py` as a fallback.
- Refactoring `poll_for_code_from_messages` beyond the minimal pragma insertion.
- Adding a writer-lock wait (`BEGIN IMMEDIATE; ROLLBACK;`).
- Touching `monitor.mjs`.
- Adding new Python dependencies.

## 7. Approval

Operator approved scope and "minimal: PRAGMA wal_checkpoint(PASSIVE) per poll" approach at 2026-05-26T01:38Z.
