# TASK-PLAN — otp-timeout-fast-retry-s-74bb

- **Status:** ready
- **Priority:** P1
- **Depends-on:** none
- **PR-base:** local main (no remote; commit locally, report SHA)
- **Parent design:** [docs/DESIGN-otp-timeout-fast-retry.md](DESIGN-otp-timeout-fast-retry.md)

## Goal

When a scheduled USCIS check fails because the OTP/login did not stick, retry the
whole login every 15 min for up to 8 rounds (~2h) before falling back to the 6h
schedule — and strengthen the Messages force-flush so the relayed code lands on
disk in seconds rather than hours. See parent design for the full problem
statement and evidence (the 2026-06-05 incident: code visible in the UI at 6:00
but not written to `chat.db` until 08:26).

## Acceptance criteria

1. On an OTP/login-not-stick failure inside the schedule window, the scheduler
   re-runs login after `retryIntervalMinutes` (default 15) instead of 6h.
2. Retries are capped at `maxRetries` (default 8); after the cap it falls back to
   `nextScheduledRun()` and sends one Discord notice ("couldn't read OTP after N
   tries").
3. A successful check resets the retry counter to 0.
4. Non-OTP errors and out-of-window retries fall back to `nextScheduledRun()`
   (no fast-retry).
5. Messages is woken before the login form is submitted and again before the
   poll, via `osascript ... activate` + best-effort `killall -CONT Messages
   imagent` (errors ignored); the weak `open -g -a Messages` is replaced.
6. The poller attempts a `TRUNCATE` WAL checkpoint and falls back to `PASSIVE`
   on `OperationalError`, never blocking the poll.
7. Config `otpRetry: { maxRetries: 8, retryIntervalMinutes: 15 }` is read from
   `config.local.json` with those defaults when absent.

## Expected files / surfaces

- `src/monitor.mjs` — tag `OTP_LOGIN_FAILED`; pure `decideNextDelay(...)`;
  wire into `runScheduler.run()`; `wakeMessages()` helper; config defaults;
  Discord exhaustion notice.
- `src/sms_imessage.py` — `TRUNCATE`→`PASSIVE` checkpoint fallback.
- `tests/monitor.test.mjs` (new) — `decideNextDelay` cases via `node --test`.
- `tests/test_sms_imessage.py` — checkpoint-fallback case.
- `config.example.json` — document the new `otpRetry` block.

## Tests (one line each)

- Retry chosen: OTP failure, count<max, in-window → 15min delay, isRetry=true.
- Cap → fallback: OTP failure, count≥max → nextScheduledRun, exhausted=true.
- Success resets: no error → nextScheduledRun, counter→0.
- Non-OTP error: generic error → nextScheduledRun, isRetry=false.
- Out-of-window: OTP failure, withinSchedule=false → nextScheduledRun.
- Checkpoint fallback: TRUNCATE raises → PASSIVE, no exception.
- Regression: existing `attributedBody` extractor fixtures still pass.

Verify: `node --test tests/` and `python3 -m pytest tests/ -q` both green.

## Non-goals

- No email-OTP channel (option #3).
- No change to the 9am–8pm ET / 6h base schedule, case-fetch, or Discord
  formatting beyond the exhaustion notice.

## Process

- Read `/Users/pinkbear/.claude/CLAUDE.md`, project `CLAUDE.md`, and project
  memory (`MEMORY.md` + `imessage_relay.md`) first.
- Unit tests ship with the change; tests are deterministic (no `time.Sleep`/timer
  assertions — `decideNextDelay` is pure).
- `/review` is mandatory; `/codex review` best-effort (skip only on rate-limit).
- No remote: commit to local `main`, report the commit SHA (not a PR URL), per
  project memory `project_workflow.md`.
- Cleanup is the last step (no stray browser/processes, temp files reaped).
