// Unit tests for the pure scheduler decision function `decideNextDelay`.
// Run via: node --test tests/
//
// `decideNextDelay` is PURE — it takes the already-computed fallback delay
// (what `nextScheduledRun()` would return) as an argument so these tests are
// deterministic with no timers, clocks, or sleeps.

import { test } from "node:test";
import assert from "node:assert/strict";

import { decideNextDelay, DEFAULT_OTP_RETRY } from "../src/monitor.mjs";

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
