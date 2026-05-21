# TASK PLAN: discord-heartbeat-reliable (fleet slug: stop-losing-discord-hear-b048)

**Parent design:** [docs/DESIGN-discord-cron-otp-and-heartbeat-fix.md](./DESIGN-discord-cron-otp-and-heartbeat-fix.md)
**Approved:** 2026-05-21T02:27:56Z
**Priority:** P2 — silent-failure path; user-visible after Bug A is fixed.
**Depends on:** `fix-sms-imessage-py-to-r-7114` landing first.

---

## Goal (one line)

Stop losing Discord heartbeats from `monitor.mjs`: log the real error cause, retry on transient failures, isolate the heartbeat from the case-API socket pool.

---

## Acceptance criteria

1. `sendDiscordWebhook(webhookUrl, payload, opts?)` retries up to **3 attempts total** on network failure (not on HTTP 4xx). Backoff: 0ms, 200ms, 800ms.
2. On final failure, the thrown error message includes `error.cause?.code` and `error.cause?.message` (e.g. `Discord webhook failed after 3 attempts: UND_ERR_SOCKET: other side closed`).
3. Every `.catch()` that swallows webhook errors logs the same `cause` detail (3 call sites: ~786, ~908, ~1058).
4. Heartbeat call at line ~911 (`changedCases === 0` branch) is invoked with `{ keepalive: false }` so it doesn't reuse the case-API connection pool.
5. No new HTTP library, no spawning `curl`, no new npm dependency.
6. Manual smoke (operator runs once on Mac): trigger `node src/monitor.mjs check-all-cases` against the real webhook; the heartbeat reaches Discord; if it fails, the log line shows a real undici cause code.

---

## Expected files & surfaces

**Modify:**
- `src/monitor.mjs`
  - Lines ~732–741: `sendDiscordWebhook` becomes:
    ```js
    async function sendDiscordWebhook(webhookUrl, payload, opts = {}) {
      const attempts = opts.attempts ?? 3;
      const backoffMs = [0, 200, 800];
      let lastErr;
      for (let i = 0; i < attempts; i++) {
        if (backoffMs[i]) await new Promise(r => setTimeout(r, backoffMs[i]));
        try {
          const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: opts.keepalive ?? true,
          });
          if (res.ok) return;
          // 4xx — don't retry, surface immediately
          if (res.status >= 400 && res.status < 500) {
            throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
          }
          lastErr = new Error(`Discord webhook failed: ${res.status} ${res.statusText}`);
        } catch (err) {
          lastErr = err;
        }
      }
      const cause = lastErr?.cause;
      const causeStr = cause ? ` (cause: ${cause.code ?? cause.name ?? "?"}: ${cause.message ?? ""})` : "";
      throw new Error(`Discord webhook failed after ${attempts} attempts: ${lastErr?.message ?? "?"}${causeStr}`);
    }
    ```
  - Line ~911 (heartbeat): pass `{ keepalive: false }`:
    ```js
    await sendDiscordWebhook(webhookUrl, { content: `✅ \`${ts} UTC\` no changes found …` }, { keepalive: false })
      .catch((err) => console.error(`  ✗ Heartbeat failed: ${err.message}`));
    ```
  - Line ~793 and ~1060 (notification + scheduled-check-failed): the new throw already includes cause; keep their existing `.catch()` but ensure they log `err.message` (which now contains cause text).

**Don't touch:**
- `src/sms_imessage.py`.
- The Playwright login flow.
- Any case-service API fetches.

---

## Test plan

There is no pure-function test possible without mocking `fetch`. Verification is manual:

```bash
# 1. Confirm the change compiles / loads
node -e "import('./src/monitor.mjs')"

# 2. Smoke 5 back-to-back webhook posts (post-implementation, operator runs)
node -e "
import('./src/monitor.mjs').then(async (m) => {
  // sendDiscordWebhook is not exported today; worker should expose it via a CLI test command
  // OR worker should add: if (command === 'webhook-test') { ... }
});
"

# 3. Real-world: trigger a check
node src/monitor.mjs check-all-cases
```

To make smoke #2 ergonomic, the worker SHOULD add a hidden `webhook-test` CLI command that posts 5 heartbeats sequentially and prints success/failure per attempt. This costs ~10 lines and is the only practical way to verify the retry path before tomorrow's cron.

---

## Implementation notes

- **Don't** add a global `Agent` or `undici.Pool` — keepalive:false on the heartbeat call alone is enough to test the stale-pool theory.
- **Don't** retry on 4xx — those mean the URL is bad or the payload is wrong, not a transient network blip.
- The 3 webhook callers (lines 786, 908, 1058 area in current monitor.mjs) all build the URL the same way; consider extracting a tiny `getWebhookUrl(config)` helper IF and ONLY IF doing so makes the diff smaller. Don't refactor for its own sake.

---

## Non-goals

- Replacing `fetch` with axios/got/node-fetch.
- Adding a heartbeat-absence external watchdog.
- Restructuring scheduler cadence.
- Wiring `email_otp.py`.

---

## Dependencies

Waits for `fix-sms-imessage-py-to-r-7114` to land so this PR can be tested against real OTP flows.
