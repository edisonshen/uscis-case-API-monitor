# DESIGN — OTP-timeout fast retry + stronger Messages flush

- **Status:** approved (operator G2, 2026-06-05)
- **Scope:** scheduler login-retry + Messages force-flush
- **Priority:** P1 (recurring failure of the core workflow)
- **Depends-on:** none
- **PR-base:** local main (no remote; worker commits locally, reports SHA)

---

## The problem (plain English)

Every weekday at 9am ET the monitor logs into USCIS, reads the case status, and
posts it to Discord. To log in it needs a 6-digit verification code that USCIS
texts to the operator's phone. We read that code from the Mac's Messages
database.

**On 2026-06-05 nothing showed up in Discord.** The login failed because the
code could not be read in time — so there was no status to post, and the next
attempt was not for another 6 hours.

The frustrating part: the code *did* arrive. It sat in Messages with a "6:00 AM"
timestamp. But the Mac's Messages app did not write that text message into its
on-disk database (`chat.db`) until **08:26** — about 2.5 hours after the login
attempt gave up at 06:05.

### Why "6:00 AM in the app" but "not in the database until 08:26"

The "6:00 AM" you see is the *origin* time — when the operator's iPhone got the
text from the carrier. The Mac receives a relayed copy over Continuity and
stamps it with that same 6:00 origin time. But Messages.app on the Mac was lazy
about saving the relayed copy to disk; it only flushed at 08:26. Our reader can
only see what is on disk, so for 2.5 hours the code was invisible to us even
though it looked present in the UI.

This was confirmed with hard evidence: the poller queried 150 times during
06:00–06:05 and got **zero rows** every time; the Mac was awake the whole time
(not asleep); and the message row's database file was not written until 08:26.

```
ORIGIN (iPhone)        RELAY COPY ON MAC              OUR READER
6:00 text arrives  ->  shows "6:00 AM" in UI      ->  queries chat.db 150x
                       but NOT written to disk         => 0 rows, every time
                       ...
8:26 finally           written to chat.db          ->  (login already gave up
                       (stamped "6:00 AM")              at 6:05; +6h until retry)
```

## How it works today

```
9:00 ET  login() opens browser, submits email+password
9:00     USCIS sends 6-digit code by SMS to the phone
9:00     maybeHandleOtp(): open -g -a Messages (background wake) + 2s wait,
         then poll chat.db for up to 5 min (300s)
9:05     5 min elapsed, still 0 rows  -> TimeoutError (swallowed, "continuing")
9:05     monitor URL still logged-out -> throw "Login did not stick"
9:05     scheduler catches error, schedules next run in 360 min (6 hours)
         -> NOTHING posted to Discord; operator left in the dark
```

Two weaknesses:
1. **A single failure costs 6 hours.** One missed code = no result until the
   next 6-hour slot, even though USCIS would happily send a fresh code minutes
   later.
2. **The wake is too weak.** `open -g -a Messages` is backgrounded and does not
   reliably un-nap the relay agent, so the text can stay unflushed for hours.

## What goes wrong

The code is unreadable for hours, the login window is 5 minutes, USCIS codes
expire in 10 minutes — and the fallback is 6 hours away. The race is lost and
stays lost for the rest of the morning.

**Polling longer within one login attempt cannot fix this** — the code expires
in 10 min and the OTP page times out. The only thing that survives a multi-hour
flush lag is to *give up this attempt and start a fresh login later*, which
makes USCIS send a brand-new code, while in the meantime nudging Messages hard
enough that it actually flushes.

## The fix

Two changes that work together. The retry loop is the guaranteed backstop; the
stronger flush shrinks the lag in the common case.

### A. Fast retry on OTP failure (the guarantee)

When a scheduled check fails *specifically because the OTP/login did not stick*,
do not wait 6 hours. Retry the whole login every **15 minutes**, up to **8
rounds (~2 hours)**, then fall back to the normal 6-hour schedule. Each round
triggers a fresh, non-expired code.

```
9:00 attempt fails (code not on disk yet)
9:15 retry #1  (fresh code)        \
9:30 retry #2  (fresh code)         |  up to 8 rounds / ~2h
...                                 |  one of these lands once Messages flushes
11:00 retry #8 (fresh code)        /
      still failing -> Discord "couldn't read OTP after 8 tries", back to 6h
```

If any round succeeds, the retry counter resets and the result posts to Discord
as normal. If all 8 fail, the operator gets a Discord notice (instead of
silence, which is what happened today).

### B. Stronger Messages flush (shrink the lag)

On each login attempt, wake Messages **earlier and harder** so the relayed text
hits `chat.db` in seconds, not hours:

- Wake Messages **before** submitting the login form (so it is already syncing
  when the code arrives), not only at poll start.
- Foreground-activate Messages and un-nap the relay agent
  (`osascript ... activate` + best-effort `killall -CONT Messages imagent`)
  instead of a backgrounded `open -g`.
- In the poller, use a **TRUNCATE** WAL checkpoint (fall back to PASSIVE) so any
  WAL-resident rows are folded into the main database the reader sees.

Force-flush is best-effort; macOS does not guarantee on-demand sync. That is why
A (retry) is the load-bearing fix and B is the accelerator.

---

## Implementation detail (for engineers)

All changes are local to `src/monitor.mjs` and `src/sms_imessage.py`. No remote;
the finisher commits to local `main` and reports the SHA.

### A. Retry loop — `src/monitor.mjs`

1. **Tag the failure.** In `login()`, track a local `otpFailed` flag set in the
   OTP `catch` (line ~553) and on `maybeHandleOtp` timeout. At the
   `"Login did not stick"` throw (line ~569), if `otpFailed`, set
   `error.code = "OTP_LOGIN_FAILED"`. Ensure this code survives the
   `checkAllCases` auto-reauth path and `scheduledCheck` (which today only
   special-cases `SESSION_EXPIRED`, else rethrows — that rethrow already carries
   the tagged error to the scheduler).

2. **Pure decision function** (unit-testable, no timers):

   ```
   decideNextDelay({ error, retryCount, withinSchedule, cfg }) ->
     { delayMs, isRetry, exhausted }
   ```
   - OTP failure + `retryCount < maxRetries` + `withinSchedule`
     -> `{ retryIntervalMinutes*60000, isRetry:true, exhausted:false }`
   - OTP failure + `retryCount >= maxRetries`
     -> `{ nextScheduledRun(), isRetry:false, exhausted:true }`
   - success or non-OTP error
     -> `{ nextScheduledRun(), isRetry:false, exhausted:false }`

3. **Wire into `runScheduler.run()`.** Keep `otpRetryCount` in the closure.
   On success reset to 0; on OTP failure increment and use the retry delay; on
   `exhausted`, send a Discord notice and reset. Replaces the unconditional
   `setTimeout(run, nextScheduledRun())` at line ~1140. Retries are still gated
   by `isWithinSchedule()`; a retry that would land outside 9am–8pm ET falls
   back to `nextScheduledRun()`.

4. **Config** (`loadConfig` defaults; overridable in `config.local.json`):
   ```json
   "otpRetry": { "maxRetries": 8, "retryIntervalMinutes": 15 }
   ```

### B. Stronger flush — `src/monitor.mjs` + `src/sms_imessage.py`

- `monitor.mjs`: add a `wakeMessages()` helper — `osascript -e 'tell application
  "Messages" to activate'` + best-effort `killall -CONT Messages imagent`
  (ignore errors). Call it once in `login()` **before** `submitLogin`, and again
  in `maybeHandleOtp` (replacing the `open -g -a Messages` line). Keep the short
  settle wait.
- `sms_imessage.py`: change `PRAGMA wal_checkpoint(PASSIVE)` to attempt
  `TRUNCATE` first, fall back to `PASSIVE` on `OperationalError`. Best-effort;
  never block the poll.

### Non-goals

- No email-OTP channel (option #3) — out of scope for this task.
- No change to the 9am–8pm ET / 6-hour base schedule.
- No change to case-fetch, Discord formatting, or auth-state handling beyond the
  new exhaustion notice.

## Test plan

| Scenario | Input | Expected |
|---|---|---|
| Retry chosen on OTP failure | error.code=OTP_LOGIN_FAILED, count=0, in-window | delayMs=15min, isRetry=true |
| Cap then fall back | same, count=8 | delayMs=nextScheduledRun, exhausted=true |
| Success resets | no error | delayMs=nextScheduledRun, isRetry=false, count->0 |
| Non-OTP error no fast-retry | generic error | delayMs=nextScheduledRun, isRetry=false |
| Retry blocked outside window | OTP failure, withinSchedule=false | delayMs=nextScheduledRun, isRetry=false |
| Checkpoint fallback | TRUNCATE raises OperationalError | falls back to PASSIVE, no raise |
| OTP extraction unchanged | existing fixtures | still pass (regression guard) |

- Node: add `tests/monitor.test.mjs` for `decideNextDelay`, run via `node --test`.
- Python: extend `tests/test_sms_imessage.py` for the checkpoint fallback;
  existing `attributedBody` fixtures guard the extractor.
