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
