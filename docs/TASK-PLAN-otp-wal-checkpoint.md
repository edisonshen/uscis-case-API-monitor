# TASK PLAN: otp-wal-checkpoint

**Parent design:** [docs/DESIGN-otp-wal-visibility-fix.md](./DESIGN-otp-wal-visibility-fix.md)
**Approved:** 2026-05-26T01:38Z
**Priority:** P1 — without it, tomorrow's 06:00 PT cron will likely fail again.

---

## Goal (one line)

Add `PRAGMA wal_checkpoint(PASSIVE)` to `src/sms_imessage.py`'s poll loop so the sqlite reader sees newly-arrived SMS that are still in `chat.db-wal`.

---

## Acceptance criteria

1. After opening a fresh `sqlite3.connect()` in each poll iteration, the script runs `conn.execute("PRAGMA wal_checkpoint(PASSIVE);")` before the SELECT.
2. Wrap the pragma in a `try/except sqlite3.OperationalError:` block — if the DB is read-only or the checkpoint fails, the poll continues without aborting (PASSIVE is safe but better defensive).
3. Bug A's existing 8 pytest cases in `tests/test_sms_imessage.py` continue to pass unchanged. The pragma is purely additive at the live-DB layer; pure-function tests don't touch it.
4. Smoke: `python3 src/sms_imessage.py --config-json '{"timeoutSeconds":2,"pollIntervalSeconds":2,"sinceSeconds":86400,"codeRegex":"\\b(\\d{6})\\b"}'` still extracts a recent USCIS code (will use existing chat.db; expected: prints a 6-digit number).
5. No new Python dependencies.

## Expected files & surfaces

**Modify:**
- `src/sms_imessage.py` — inside `poll_for_code_from_messages`, between the `sqlite3.connect()` call and the `cursor.execute(SELECT...)`. Roughly:
  ```python
  conn = sqlite3.connect(db_path, timeout=5)
  conn.row_factory = sqlite3.Row
  cursor = conn.cursor()
  # Force any pending Messages.app writes in chat.db-wal to merge into the
  # main DB so this reader's snapshot includes them. Messages.app's default
  # auto-checkpoint threshold (1000 pages) sometimes lags by minutes when the
  # system is coming out of sleep, hiding fresh SMS from us mid-poll.
  try:
      cursor.execute("PRAGMA wal_checkpoint(PASSIVE);")
  except sqlite3.OperationalError:
      pass
  cursor.execute("""SELECT ...""", (cutoff_ns,))
  ```

**Don't touch:**
- Tests (no new tests needed; existing 8 still pass).
- `src/monitor.mjs`.
- `src/email_otp.py`.
- Any docs already committed.

## Test plan

```bash
cd /Users/pinkbear/projects/uscis-case-API-monitor
python3 -m pytest tests/ -q          # must pass: 8 tests
python3 src/sms_imessage.py --config-json '{"timeoutSeconds":2,"pollIntervalSeconds":2,"sinceSeconds":86400,"codeRegex":"\\b(\\d{6})\\b"}' 2>&1
# expect: prints "793499" (or whatever recent USCIS code is in the DB)
```

## Output contract (local repo — no PR)

Per project memory at `~/.claude/projects/-Users-pinkbear-projects-uscis-case-API-monitor/memory/project_workflow.md`:

- Do NOT run `gh pr create` or `git push` (no remote).
- Commit on `main` locally.
- Return contract = commit SHA on main, not PR URL.
- Reviewers (/codex review + /review) mandatory.

## Non-goals

- Adding `BEGIN IMMEDIATE; ROLLBACK;` writer-lock wait.
- Wiring `email_otp.py`.
- Bumping `pollIntervalSeconds`, `sinceSeconds`, or other config defaults.
- Touching `monitor.mjs`.

## Dependencies

None. Independent of Bug A and Bug B; both already landed.
