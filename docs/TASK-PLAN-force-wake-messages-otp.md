# TASK PLAN: force-wake-messages-otp

**Parent design:** [docs/DESIGN-force-wake-messages-app.md](./DESIGN-force-wake-messages-app.md)
**Approved:** 2026-05-26T17:00Z
**Priority:** P1 — without this, tomorrow's 06:00 PT cron is likely to fail again with the same iMessage-relay-delay symptom.

---

## Goal (one line)

Add a non-blocking `open -g -a Messages` warmup right before the SMS-iMessage OTP poll in `src/monitor.mjs`, so iMessage Continuity sync is active by the time the Python script polls chat.db.

---

## Acceptance criteria

1. `src/monitor.mjs`'s `maybeHandleOtp(page, config)` (currently at line 341) gains a warmup block immediately before the `const rawCode = await readOtp(config.otp);` call (currently line 361).
2. The warmup only runs when `mode === "sms-imessage"` (NOT when `mode === "imap"` or anything else).
3. The warmup is best-effort: any spawn failure, exit code, or exception is silently swallowed. It must NEVER throw out of `maybeHandleOtp`.
4. The warmup adds a small `await page.waitForTimeout(2000)` after the spawn returns, giving Messages.app a chance to wake before the poll opens chat.db.
5. `node -e "import('./src/monitor.mjs')"` loads cleanly (no syntax error).
6. `node src/monitor.mjs check-all-cases` succeeds end-to-end (uses existing auth.json — no actual OTP poll needed; just verifies the file still parses and the happy path still works).
7. Existing 8 pytest cases in `tests/test_sms_imessage.py` continue to pass (fix doesn't touch Python; this is a sanity check).
8. No new npm or Python dependencies.

---

## Expected files & surfaces

**Modify:**
- `src/monitor.mjs` — add ~15 lines inside `maybeHandleOtp`, between line 358 (`}`) and line 360 (`console.log(`  Reading OTP code from ${modeLabel}...`)`). Concretely:

  ```js
  // Force-wake Messages.app so iMessage Continuity starts syncing from the
  // iPhone before the Python OTP poll opens chat.db. m.date in chat.db is
  // the SMS origin time, not the local insert time — if Messages.app is
  // suspended, the row can be missing from chat.db for hours.
  if (mode === "sms-imessage") {
    console.log("  Force-waking Messages.app for iMessage Continuity sync...");
    try {
      await new Promise((resolve) => {
        const child = spawn("open", ["-g", "-a", "Messages"], { stdio: "ignore" });
        child.on("close", () => resolve());
        child.on("error", () => resolve());
      });
      await page.waitForTimeout(2000);
    } catch {
      // best-effort — if anything goes wrong, fall through to the poll
    }
  }
  ```

  `spawn` is already imported elsewhere in monitor.mjs (used to launch the Python OTP poller at line 207) — no new imports needed. Verify by greping.

**Don't touch:**
- `src/sms_imessage.py`, `tests/`, `docs/DESIGN-*.md` from earlier work.
- `package.json`, `package-lock.json` (still operator-owned, still showing as modified in working tree — leave them alone).
- `src/email_otp.py` (out of scope).

---

## Test plan

```bash
cd /Users/pinkbear/projects/uscis-case-API-monitor

# 1. File compiles / loads
node -e "import('./src/monitor.mjs')"

# 2. Happy path (auth.json already fresh — no actual OTP poll triggered)
node src/monitor.mjs check-all-cases 2>&1 | tail -15
# Expect: 4 cases checked, "no changes" summary, no errors.

# 3. Existing tests still pass (sanity)
python3 -m pytest tests/ -q
# Expect: 8 passed
```

No automated test for the warmup itself — its effect is only observable on a real Mac with a sleeping Messages.app. Operator will validate tomorrow morning.

---

## Output contract (local repo — no PR)

- Do NOT run `gh pr create` or `git push` (no remote).
- Commit to `main` locally; return commit SHA.
- Both `/codex review` and `/review` skill mandatory before commit.

---

## Operator follow-up after worker lands

Once the worker commits, operator must run **`./uscis.sh restart`** to pick up the new `monitor.mjs`. The Python script doesn't change so no Python-side concerns.

Worker should include this restart instruction in their return message so operator doesn't forget.

---

## Non-goals

- Wiring `src/email_otp.py` as fallback (deferred — file a separate task if needed after observing tomorrow's cron).
- Adding AppleScript / `osascript` invocations.
- Adding a watchdog that monitors Messages.app health.
- Restarting the daemon automatically.
- Touching `sms_imessage.py`.
- Changing schedule or poll cadence.

---

## Dependencies

None. Independent of Bug A, B, C (all already landed).
