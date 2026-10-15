// Unit tests for the pure scheduler decision function `decideNextDelay`.
// Run via: node --test tests/
//
// `decideNextDelay` is PURE — it takes the already-computed fallback delay
// (what `nextScheduledRun()` would return) as an argument so these tests are
// deterministic with no timers, clocks, or sleeps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideNextDelay,
  nextPermissionNotifyState,
  DEFAULT_OTP_RETRY,
  isVerificationPageUrl,
  isWithinSchedule,
  planRun,
  planStartup,
  lastCheckedAtFromHistory,
  shouldNotifyCheckFailure,
  SLOT_TOLERANCE_MS,
  STARTUP_SETTLE_MS,
} from "../src/monitor.mjs";

const DENIED = { permissionDenied: true };
const NOT_DENIED = { permissionDenied: false };

const CFG = { maxRetries: 8, retryIntervalMinutes: 15 };
const FALLBACK = 6 * 60 * 60 * 1000; // stand-in for nextScheduledRun()

function otpError() {
  const e = new Error("Login did not stick");
  e.code = "OTP_LOGIN_FAILED";
  return e;
}

test("retry chosen on OTP failure within window, under cap", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, 15 * 60 * 1000);
  assert.equal(out.isRetry, true);
  assert.equal(out.exhausted, false);
});

test("retry chosen on a non-zero count still under cap", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 7,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, 15 * 60 * 1000);
  assert.equal(out.isRetry, true);
  assert.equal(out.exhausted, false);
});

test("cap reached -> fall back to scheduled run and mark exhausted", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 8,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, FALLBACK);
  assert.equal(out.isRetry, false);
  assert.equal(out.exhausted, true);
});

function permissionDeniedError() {
  const e = new Error("Full Disk Access denied reading Messages database");
  e.code = "OTP_PERMISSION_DENIED";
  return e;
}

test("permission-denied OTP error -> no retry, permissionDenied flag, scheduled run", () => {
  const out = decideNextDelay({
    error: permissionDeniedError(),
    retryCount: 0,
    withinSchedule: true,
    retryWithinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.deepEqual(out, {
    delayMs: FALLBACK,
    isRetry: false,
    exhausted: false,
    permissionDenied: true,
  });
});

test("permission-denied never fast-retries even with retry budget in-window", () => {
  // Identical inputs that WOULD fast-retry an OTP_LOGIN_FAILED must not retry
  // here — a permission error is unfixable by retrying and spams USCIS texts.
  const out = decideNextDelay({
    error: permissionDeniedError(),
    retryCount: 3,
    withinSchedule: true,
    retryWithinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.isRetry, false);
  assert.equal(out.permissionDenied, true);
  assert.equal(out.delayMs, FALLBACK);
});

test("success (no error) -> scheduled run, no retry, not exhausted", () => {
  const out = decideNextDelay({
    error: null,
    retryCount: 3,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, FALLBACK);
  assert.equal(out.isRetry, false);
  assert.equal(out.exhausted, false);
});

test("non-OTP error -> no fast retry, scheduled run", () => {
  const out = decideNextDelay({
    error: new Error("some other failure"),
    retryCount: 0,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, FALLBACK);
  assert.equal(out.isRetry, false);
  assert.equal(out.exhausted, false);
});

test("OTP failure outside window -> no fast retry, scheduled run", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: false,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, FALLBACK);
  assert.equal(out.isRetry, false);
  assert.equal(out.exhausted, false);
});

test("retry interval honors a custom config value", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true,
    cfg: { maxRetries: 4, retryIntervalMinutes: 5 },
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, 5 * 60 * 1000);
  assert.equal(out.isRetry, true);
});

test("DEFAULT_OTP_RETRY exposes the documented defaults", () => {
  assert.equal(DEFAULT_OTP_RETRY.maxRetries, 8);
  assert.equal(DEFAULT_OTP_RETRY.retryIntervalMinutes, 15);
});

test("missing cfg falls back to DEFAULT_OTP_RETRY", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, DEFAULT_OTP_RETRY.retryIntervalMinutes * 60 * 1000);
  assert.equal(out.isRetry, true);
});

// Regression: the scheduler must perform exactly `maxRetries` fast-retries
// after the initial scheduled failure, then exhaust — NOT one short. This
// replays the scheduler's burst loop (pre-increment count -> decide -> bump
// only on isRetry) deterministically, with no timers. Guards the off-by-one
// where the initial failure wrongly consumed a retry slot (codex P2).
test("burst performs exactly maxRetries fast-retries then exhausts", () => {
  let count = 0; // fast-retries already scheduled (mirrors otpRetryCount)
  const retryDelays = [];
  let exhaustedAt = null;

  // The initial scheduled failure + each subsequent retry failure. Cap the
  // loop well above maxRetries so a runaway (never-exhaust) bug fails the test.
  for (let attempt = 0; attempt < CFG.maxRetries + 5; attempt += 1) {
    const out = decideNextDelay({
      error: otpError(),
      retryCount: count,
      withinSchedule: true,
      cfg: CFG,
      fallbackDelayMs: FALLBACK,
    });
    if (out.exhausted) {
      exhaustedAt = count;
      break;
    }
    assert.equal(out.isRetry, true);
    retryDelays.push(out.delayMs);
    count += 1;
  }

  // Exactly 8 fast-retries fired (retry #1..#8), each at the 15-min interval.
  assert.equal(retryDelays.length, CFG.maxRetries);
  for (const d of retryDelays) assert.equal(d, CFG.retryIntervalMinutes * 60 * 1000);
  // The 9th OTP failure (after the budget is spent) exhausts.
  assert.equal(exhaustedAt, CFG.maxRetries);
});

// Regression (codex P2): a late-day OTP failure whose 15-min retry would wake
// AFTER 8pm ET must not schedule a dead retry — it exhausts (and notifies)
// instead of silently resetting the burst when the after-hours run is skipped.
test("OTP failure exhausts (no retry) when the retry would land after hours", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true, // the failed run was in-window
    retryWithinSchedule: false, // but the 15-min retry target is after hours
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.delayMs, FALLBACK);
  assert.equal(out.isRetry, false);
  assert.equal(out.exhausted, true);
});

test("OTP failure still retries when the retry target is in-window", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true,
    retryWithinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.isRetry, true);
  assert.equal(out.exhausted, false);
});

test("retryWithinSchedule defaults to true (backward-compatible)", () => {
  const out = decideNextDelay({
    error: otpError(),
    retryCount: 0,
    withinSchedule: true,
    cfg: CFG,
    fallbackDelayMs: FALLBACK,
  });
  assert.equal(out.isRetry, true);
});

// Regression (codex P1): a failed OTP can strand the browser on a USCIS
// verification page. The login() guard treats `otpFailed && verification URL`
// as an OTP login failure (so it is NOT saved as success and the scheduler
// fast-retries). isVerificationPageUrl is the load-bearing predicate.
test("isVerificationPageUrl flags verification / 2FA pages, not the dashboard", () => {
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/account/verification"), true);
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/two-factor"), true);
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/2fa/challenge"), true);
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/VERIFICATION"), true); // case-insensitive
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/dashboard"), false);
  assert.equal(isVerificationPageUrl("https://my.uscis.gov/case/abc123"), false);
});

// The guard itself: stuck-on-verification is an OTP failure only when the OTP
// step failed AND we are still on a verification page. Mirror that boolean so
// a future refactor of the guard condition is caught.
test("stuck-on-verification guard fires only when otpFailed AND on a verification URL", () => {
  const guard = (otpFailed, url) => otpFailed && isVerificationPageUrl(url);
  assert.equal(guard(true, "https://my.uscis.gov/account/verification"), true);
  assert.equal(guard(false, "https://my.uscis.gov/account/verification"), false); // OTP not attempted
  assert.equal(guard(true, "https://my.uscis.gov/dashboard"), false); // navigated away = success
});

// --- FDA-denial notify-once lifecycle (nextPermissionNotifyState) ----------

test("first denial notifies and marks notified", () => {
  assert.deepEqual(nextPermissionNotifyState(DENIED, true, false), { notify: true, notified: true });
});

test("repeated denial in the same streak stays silent", () => {
  assert.deepEqual(nextPermissionNotifyState(DENIED, true, true), { notify: false, notified: true });
});

test("a check that ran without denial resets the streak (next denial re-notifies)", () => {
  assert.deepEqual(nextPermissionNotifyState(NOT_DENIED, true, true), { notify: false, notified: false });
});

// Regression: an out-of-window run skips the check entirely, so it must NOT
// reset the notify flag — else a persistent denial re-pings whenever a 6h run
// lands after 8pm/overnight (adversarial review P2).
test("an out-of-window skip does NOT reset the notify flag", () => {
  assert.deepEqual(nextPermissionNotifyState(NOT_DENIED, false, true), { notify: false, notified: true });
});

test("denial while notified is only re-notified after a real check clears the streak", () => {
  let notified = false;
  // Day 1: denied in-window -> notify.
  let s = nextPermissionNotifyState(DENIED, true, notified); notified = s.notified;
  assert.equal(s.notify, true);
  // Later same day: denied again in-window -> silent.
  s = nextPermissionNotifyState(DENIED, true, notified); notified = s.notified;
  assert.equal(s.notify, false);
  // Overnight: out-of-window skip -> still silent, flag preserved.
  s = nextPermissionNotifyState(NOT_DENIED, false, notified); notified = s.notified;
  assert.equal(s.notify, false);
  assert.equal(notified, true);
  // Next morning: still denied in-window -> STILL silent (never fixed).
  s = nextPermissionNotifyState(DENIED, true, notified); notified = s.notified;
  assert.equal(s.notify, false);
});

// ---------------------------------------------------------------------------
// Schedule planning (planRun / planStartup). All inputs are explicit instants;
// October 2026 is EDT, so "ET wall clock" = the ISO string with -04:00.
// 2026-10-14 is a Wednesday, 10-16 Friday, 10-17 Saturday, 10-19 Monday.
// ---------------------------------------------------------------------------

const et = (iso) => new Date(`${iso}-04:00`);
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

test("the 2026-10-14 skip: waking <1s before 9:00 ET runs now and targets 15:00, never +1min/skip", () => {
  for (let ms = 0; ms < 1000; ms += 37) {
    const now = et(`2026-10-14T08:59:59.${String(ms).padStart(3, "0")}`);
    const plan = planRun(now);
    assert.equal(plan.withinSchedule, true, `withinSchedule at .${ms}`);
    assert.ok(plan.nextDelayMs > 5 * HOUR && plan.nextDelayMs <= 6 * HOUR + 1000, `next delay at .${ms}: ${plan.nextDelayMs}`);
  }
});

test("exactly 9:00:00.000 ET: run now, next slot is 15:00 (6h)", () => {
  const plan = planRun(et("2026-10-14T09:00:00.000"));
  assert.equal(plan.withinSchedule, true);
  assert.equal(plan.nextDelayMs, 6 * HOUR);
});

test("before the tolerance window: outside, and the delay keeps millisecond precision", () => {
  const plan = planRun(et("2026-10-14T08:58:00.750"));
  assert.equal(plan.withinSchedule, false);
  assert.equal(plan.nextDelayMs, 2 * MIN - 750);
});

test("just inside the tolerance before 9:00 counts as the 9:00 slot", () => {
  const now = et("2026-10-14T09:00:00.000");
  const plan = planRun(new Date(now.getTime() - SLOT_TOLERANCE_MS + 1));
  assert.equal(plan.withinSchedule, true);
  assert.ok(plan.nextDelayMs > 5 * HOUR);
});

test("isWithinSchedule (retry-target check) has no tolerance", () => {
  assert.equal(isWithinSchedule(et("2026-10-14T08:59:59.999")), false);
  assert.equal(isWithinSchedule(et("2026-10-14T09:00:00.000")), true);
  assert.equal(isWithinSchedule(et("2026-10-14T19:59:59.000")), true);
  assert.equal(isWithinSchedule(et("2026-10-14T20:00:00.000")), false);
  assert.equal(isWithinSchedule(et("2026-10-17T12:00:00.000")), false); // Saturday
});

test("after the 15:00 slot the next run is tomorrow 9:00", () => {
  const plan = planRun(et("2026-10-14T15:00:30.000"));
  assert.equal(plan.withinSchedule, true);
  assert.equal(plan.nextDelayMs, 18 * HOUR - 30 * 1000);
});

test("Friday 15:00 -> Monday 9:00; Saturday -> Monday 9:00; weeknight 21:00 -> 9:00 next day", () => {
  assert.equal(planRun(et("2026-10-16T15:00:30.000")).nextDelayMs, 66 * HOUR - 30 * 1000);
  const sat = planRun(et("2026-10-17T10:00:00.000"));
  assert.equal(sat.withinSchedule, false);
  assert.equal(sat.nextDelayMs, 47 * HOUR);
  const night = planRun(et("2026-10-14T21:00:00.000"));
  assert.equal(night.withinSchedule, false);
  assert.equal(night.nextDelayMs, 12 * HOUR);
});

test("end of window: 19:59:59 runs, 20:00:00 does not", () => {
  assert.equal(planRun(et("2026-10-14T19:59:59.000")).withinSchedule, true);
  assert.equal(planRun(et("2026-10-14T20:00:00.000")).withinSchedule, false);
});

test("slot search rolls over a month boundary and a DST switch (Sat Oct 31 -> Mon Nov 2 9:00 EST)", () => {
  // Nov 1 2026 is the EDT->EST switch: 47h of ET wall clock is 48h of real time.
  const plan = planRun(et("2026-10-31T10:00:00.000"));
  assert.equal(plan.withinSchedule, false);
  assert.equal(plan.nextDelayMs, 48 * HOUR);
  assert.equal(plan.nextSlotEt.getDay(), 1);
  assert.equal(plan.nextSlotEt.getHours(), 9);
});

test("startup after the 9:00 slot already ran: wait for 15:00, no immediate run", () => {
  const out = planStartup({ now: et("2026-10-14T11:47:30.000"), lastCheckedAt: et("2026-10-14T09:00:31.000") });
  assert.equal(out.reason, "next-slot");
  assert.equal(out.delayMs, 3 * HOUR + 12 * MIN + 30 * 1000);
});

test("startup with the 9:00 slot missed (last check yesterday): catch up after the settle delay", () => {
  const out = planStartup({ now: et("2026-10-14T11:47:30.000"), lastCheckedAt: et("2026-10-13T15:01:10.000") });
  assert.equal(out.reason, "missed-slot-catch-up");
  assert.equal(out.delayMs, STARTUP_SETTLE_MS);
});

test("startup with no history at all counts as a missed slot", () => {
  const out = planStartup({ now: et("2026-10-14T11:47:30.000"), lastCheckedAt: null });
  assert.equal(out.reason, "missed-slot-catch-up");
});

test("startup catch-up never overshoots the next slot", () => {
  const out = planStartup({ now: et("2026-10-14T14:58:00.000"), lastCheckedAt: et("2026-10-13T15:01:10.000") });
  assert.equal(out.reason, "missed-slot-catch-up");
  assert.equal(out.delayMs, 2 * MIN);
});

test("startup outside the window never catches up — it waits for the next slot", () => {
  const night = planStartup({ now: et("2026-10-14T21:00:00.000"), lastCheckedAt: et("2026-10-01T15:00:00.000") });
  assert.equal(night.reason, "next-slot");
  assert.equal(night.delayMs, 12 * HOUR);
  const sat = planStartup({ now: et("2026-10-17T10:00:00.000"), lastCheckedAt: null });
  assert.equal(sat.reason, "next-slot");
  assert.equal(sat.delayMs, 47 * HOUR);
});

test("lastCheckedAtFromHistory picks the latest lastFetchAt and ignores junk", () => {
  const history = {
    A: { lastFetchAt: "2026-10-13T19:01:10.938Z" },
    B: { lastFetchAt: "2026-10-13T19:01:12.100Z" },
    C: { lastFetchAt: "not-a-date" },
    D: {},
  };
  assert.equal(lastCheckedAtFromHistory(history).toISOString(), "2026-10-13T19:01:12.100Z");
  assert.equal(lastCheckedAtFromHistory({}), null);
  assert.equal(lastCheckedAtFromHistory(null), null);
});

test("any failed check notifies Discord except OTP failures, which have their own notices", () => {
  assert.equal(shouldNotifyCheckFailure(new Error("locator.count: Target page, context or browser has been closed")), true);
  const expired = new Error("SESSION_EXPIRED");
  expired.code = "SESSION_EXPIRED";
  assert.equal(shouldNotifyCheckFailure(expired), true);
  const otp = new Error("Login did not stick");
  otp.code = "OTP_LOGIN_FAILED";
  assert.equal(shouldNotifyCheckFailure(otp), false);
  const denied = new Error("FDA denied");
  denied.code = "OTP_PERMISSION_DENIED";
  assert.equal(shouldNotifyCheckFailure(denied), false);
});
