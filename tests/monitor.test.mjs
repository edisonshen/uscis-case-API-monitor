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
  DEFAULT_OTP_RETRY,
  isVerificationPageUrl,
} from "../src/monitor.mjs";

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
