# DESIGN: Force-wake Messages.app before OTP poll (Bug D)

**Status:** Approved 2026-05-26T17:00Z by operator.
**Author:** Coordinator (Claude Code).
**Scope:** Make `monitor.mjs` force-launch Messages.app right before the OTP poll so iMessage Continuity sync starts and the SMS row lands in chat.db within the poll window.

---

## 1. Summary

Bug A (commit `0c10492`), Bug B (`8c73c9c`), and Bug C (`89de663`) all landed and verify clean. Today (2026-05-26 06:00 PT) the cron still failed at the OTP step. Investigation shows:

- Operator's iPhone DID receive the USCIS verification SMS at 06:00:10 on schedule.
- The `chat.db` mtime / WAL state show the row only landed in the Mac's local Messages DB at ~10:05, about 4 hours after the cron poll ended at 06:05:13.
- The Python sqlite reader inside `sms_imessage.py` cannot read a row that hasn't been inserted yet — Bug C's `PRAGMA wal_checkpoint(PASSIVE)` is correct but doesn't help if the row never made it to the WAL during the poll window.
- `m.date` in chat.db is the SMS origin time at the carrier, NOT the local insertion time. The "06:00:10" timestamp is misleading.

**Root cause:** macOS Messages.app sometimes remains in a sleep/suspended state when Node.js wakes briefly to run a cron job. iMessage Continuity from iPhone → Mac doesn't sync until Messages.app becomes active. Without an active Messages.app, the SMS sits on the iPhone (or in some macOS relay queue) and doesn't appear in chat.db.

## 2. Design decision

Before the OTP poll begins, **force-launch Messages.app in the background** so iMessage Continuity starts syncing immediately:

```js
// inside maybeHandleOtp(), just before readOtp(config.otp):
if (mode === "sms-imessage") {
  try {
    await new Promise((resolve) => {
      const child = spawn("open", ["-g", "-a", "Messages"], { stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
    });
    await page.waitForTimeout(2000);  // give Messages a moment to wake + start syncing
  } catch {
    // best effort — if open fails, fall through to the poll
  }
}
```

- `open -g` launches without bringing Messages to the foreground (no jarring focus-steal if the operator is using the Mac).
- `-a Messages` says "open with Messages.app" — idempotent: if Messages is already running, this is a no-op.
- The 2-second wait gives Messages.app time to wake from suspension and start its Continuity sync handshake before our Python poll opens chat.db. The poll itself runs for 300s; combined with the 2s warmup we now have 302s of "Messages.app is active" time.
- Wrapped in try/catch so a missing `Messages` app, sandboxing issue, or Linux runner doesn't fail the OTP flow — best-effort.
- Only fires when `mode === "sms-imessage"`. Email mode is unaffected.

**Why not AppleScript (`osascript -e 'tell application "Messages" to launch'`)?** Same effect, more typing, harder to read, depends on `osascript` (which is also pre-installed but adds another moving piece). `open -ga Messages` is the macOS-canonical way to launch a bundle.

**Why not run `open Messages` at cron startup (once)?** Messages.app can re-enter sleep / suspension between cron ticks. Calling at OTP time is the moment we actually need it awake.

**Why not the broader "email OTP fallback" route?** Operator picked the lighter fix first. If force-wake doesn't fully resolve, email OTP via `src/email_otp.py` (already exists, currently unwired) is the next escalation.

## 3. Task split

Single task. ~15-line diff.

| Slug | Goal |
|---|---|
| `force-wake-messages-otp` | Add the `open -g -a Messages` warmup before SMS-iMessage OTP poll in monitor.mjs |

## 4. Test plan

- Existing pytest (8 cases) untouched — fix is in monitor.mjs, not in `sms_imessage.py`.
- Smoke verification (worker):
  - `node -e "import('./src/monitor.mjs')"` — ensures the file still loads.
  - `node src/monitor.mjs check-all-cases` — verify happy path still works (auth.json fresh, no login needed).
- Operational verification (operator, tomorrow morning):
  - Watch `state/scheduler.log` after 06:00 PT cron.
  - Expect to see `[sms-test] Found N candidate message(s)` and a code extraction. If the next morning cron succeeds and posts "✅ no changes found" to Discord, the fix works.

## 5. Assumptions

- The daemon is running pid 19010 (restarted 2026-05-25 18:00 PT to pick up Bug B's monitor.mjs). It will pick up THIS change only after another restart — note this in the task.
- Operator is signed into iMessage on the Mac and "Text Message Forwarding" is enabled on the iPhone for this Mac.
- `Messages.app` is at the standard `/System/Applications/Messages.app` path.
- The 2-second warmup is enough; if not, we'll learn from tomorrow's cron and may need to bump it.

## 6. Non-goals

- Wiring `src/email_otp.py` as fallback (deferred — separate task if this fix proves insufficient).
- Adding any new dependencies (no AppleScript wrapper libs, no osascript invocations).
- Touching `sms_imessage.py` (Bug A/C fixes stay).
- Changing scheduler cadence or schedule windows.
- Auto-restarting the daemon when monitor.mjs changes (operator does manual `./uscis.sh restart`).

## 7. Approval

Operator approved scope and "force-wake Messages.app before OTP poll" approach on 2026-05-26 after confirming iPhone received the SMS on time but Mac didn't see it.
