# DESIGN: Fix missing Discord cron heartbeat — OTP read path and Discord fetch reliability

**Status:** Approved 2026-05-21T02:27:56Z by operator (edisonshen87@gmail.com).
**Author:** Coordinator (Claude Code) on behalf of operator.
**Scope:** Two distinct bugs that together explain "I didn't see today's result in Discord, only the message."

---

## 1. Summary

On 2026-05-20, the scheduled USCIS case check ran on schedule at 06:00 and 12:05 local. Both runs failed at the OTP step. A manual run at 19:22 succeeded and confirmed all 4 cases unchanged.

Two distinct bugs were uncovered:

- **Bug A (P1):** `src/sms_imessage.py` reads only `message.text` from the macOS Messages SQLite DB. On macOS 13+ the iMessage app stores incoming SMS bodies in `message.attributedBody` (typedstream-encoded NSAttributedString) and frequently leaves `text` NULL. Today's 06:00 and 12:05 USCIS verification SMS both landed `text=NULL, attributedBody=NOT NULL`, so the keyword filter `WHERE text IS NOT NULL AND text LIKE '%verification%'` matched zero rows and the poll timed out at 300s. The 19:22 SMS happened to land `text=NOT NULL`, which is why the manual run worked. The behavior is non-deterministic; tomorrow's cron will fail again unless we read `attributedBody`.

- **Bug B (P2):** Even when OTP succeeds, `monitor.mjs:913` reports `✗ Heartbeat failed: fetch failed` and the "no changes" message never reaches Discord. Reproduced twice in the same `check-all-cases` invocation today. The Discord webhook URL works fine via `curl` and via an isolated `node -e` script. The failure only manifests inside the monitor.mjs runtime — most plausible cause is a stale undici socket pool after the Playwright browser session and the case-service API fetches. The current `.catch()` swallows the error without logging `error.cause`, so we have no diagnostic detail.

A third opportunity (`src/email_otp.py` exists but is unwired) is **out of scope** for this design; revisit after the two P-bugs land.

---

## 2. Design decisions

### 2.1 Bug A — read attributedBody as fallback (byte-level extraction)

**Decision:** Modify `src/sms_imessage.py` to:

1. Broaden the SQL filter to include rows where the keyword may live in `attributedBody`:
   ```sql
   SELECT m.ROWID, m.text, m.attributedBody, m.date, m.service
   FROM message m
   WHERE m.date >= ?
     AND (
       (m.text IS NOT NULL AND (m.text LIKE '%verification%' OR m.text LIKE '%USCIS%' OR m.text LIKE '%secure%'))
       OR m.attributedBody IS NOT NULL
     )
   ORDER BY m.date DESC
   LIMIT 100
   ```
2. For each row, build a single "haystack" string from `text` (if present) plus the readable ASCII run extracted from `attributedBody`. Extraction rule: scan the blob bytes, keep runs of printable ASCII (`0x20`–`0x7E`) of length ≥ 4, join with spaces. The USCIS verification text "`<6-digit code> is the secure verification code for logging into your USCIS Online Account…`" is stored verbatim as readable UTF-8 inside the typedstream blob (confirmed by hex-decode of today's blobs).
3. Apply the existing keyword filter (`verification`, `USCIS`, `secure`) at the **Python level** against the combined haystack, then run the existing `codeRegex` (`\b(\d{6})\b`) to extract the code.
4. The youngest matching message wins, same as today.

**Why byte-level extraction:**
- Zero new dependencies.
- ~20 lines added.
- typedstream parsing is a known footgun across macOS versions; printable-ASCII scan is forward-compatible.
- The text is unambiguously present as readable UTF-8 in the blob (verified against 3 captured fixtures).

**Tradeoff accepted:** the printable-ASCII scan will also surface format-control bytes from the typedstream wrapper as garbage. That's fine because we apply the keyword filter *after* extraction and only act on messages that contain `verification` AND match the code regex. No risk of accepting bogus codes from non-USCIS messages — the negative fixture (apartment-renewal text, no `verification` keyword, no 6-digit run with verification context) verifies this.

### 2.2 Bug B — log error.cause and retry with backoff

**Decision:** Modify `src/monitor.mjs` `sendDiscordWebhook` + its callers:

1. **Log `error.cause`** in every `.catch()` that swallows webhook errors, so the next failure tells us the underlying undici code (e.g. `UND_ERR_SOCKET`, `ECONNRESET`). Today's `fetch failed` is the undici default message with no detail because `cause` is being dropped.
2. **Add a retry shim inside `sendDiscordWebhook`:** up to 3 attempts with 200ms / 800ms backoff. Returns success on first 2xx; throws aggregated error on final failure.
3. **Pass `keepalive: false`** on the heartbeat call (only the heartbeat; case-API fetches are unrelated). This prevents the case-API connection pool from being reused for the Discord host, which is the most plausible source of the stale-socket issue.
4. **Do not** introduce a new HTTP library or spawn `curl` as a fallback — keep the change minimal until we can read what `cause` actually says.

### 2.3 Test discipline

**Bug A:**
- Capture 4 attributedBody fixtures (already done; see §4):
  - 2 USCIS texts with `text=NULL` (today's 06:00 and 12:05 — codes 145950 and 983284)
  - 1 USCIS text with `text=NOT NULL` (today's 19:22 — code 447431, regression check that we don't double-extract or break the fast path)
  - 1 non-USCIS text (apartment renewal — negative case, must return None)
- pytest suite (`tests/test_sms_imessage.py`) drives a new pure-function `extract_code_from_row(text, attributed_body_bytes, code_regex, keywords)` and asserts:
  - extracts `145950` from blob A
  - extracts `983284` from blob B
  - extracts `447431` from blob C (regardless of which column it comes from)
  - returns `None` from negative blob D
- Tests are pure-Python with no DB / network / macOS dependency. Fixtures live under `tests/fixtures/sms_attributedbody/*.hex` (hex-encoded so they're git-friendly).

**Bug B:**
- No pure-function test possible without mocking fetch. Instead:
  - Smoke test: a small `node -e` snippet that invokes `sendDiscordWebhook` 5× in a loop against the real webhook with a clearly-marked test payload (operator runs once locally; not part of CI).
  - Add an assertion-style check in code: `console.error` includes `cause?.code` and `cause?.message`.

---

## 3. Task split

Two tasks; both unblocked, can run in parallel (cap=1 default — they'll run sequentially in dispatch order):

| Slug | Goal | Files touched | Tests |
|---|---|---|---|
| `otp-attributedbody-read` | Make sms_imessage.py read attributedBody so cron OTP works on macOS 13+ | `src/sms_imessage.py`, `tests/test_sms_imessage.py`, `tests/fixtures/sms_attributedbody/*.hex` (already captured) | pytest, 4 cases |
| `discord-heartbeat-reliable` | Stop losing Discord heartbeats; log error.cause; retry; isolate from API socket pool | `src/monitor.mjs` (sendDiscordWebhook + 3 callers at 786, 908, 1058) | manual smoke + console log assertion |

Order: `otp-attributedbody-read` first (P1, blocks tomorrow's cron). `discord-heartbeat-reliable` second (P2, blocks reliable success notifications).

---

## 4. Captured fixtures (already on disk)

```
tests/fixtures/sms_attributedbody/
  2026-05-20T06-00-08_uscis_145950.hex            (text=NULL, code 145950 in blob)
  2026-05-20T11-57-58_apartment_NEGATIVE.hex      (negative, no USCIS keyword)
  2026-05-20T12-05-30_uscis_983284.hex            (text=NULL, code 983284 in blob)
  2026-05-20T19-22-42_uscis_447431.hex            (text=NOT NULL, code 447431, regression check)
```

Worker loads each as `bytes.fromhex(open(path).read().strip())`.

---

## 5. Assumptions

- macOS Messages DB schema (`message` table columns `text`, `attributedBody`, `date`, `service`) is stable enough that we don't need a schema-version guard for this fix. Today's behavior was confirmed on macOS 15.5 (Darwin 25.5.0).
- Full Disk Access for the terminal running the scheduler is already in place (yesterday's runs proved this).
- The Discord webhook URL itself is healthy (verified via curl manual post 2026-05-21T02:24Z).
- The Node version is 22.18.0; no upgrade in scope.
- No new dependencies added; the project must keep its dep-light posture.

---

## 6. Non-goals

- Wiring `src/email_otp.py` as a second-channel OTP fallback. Worth doing later for resilience but out of scope here.
- Adding a heartbeat-absence alarm (an external watchdog that yells if no Discord message arrives for 24h).
- Migrating away from undici / Node fetch.
- Reworking the scheduler cadence or schedule windows.
- Refactoring the 3 duplicated `webhookUrl = config?.discordWebhookUrl || process.env.…` blocks in monitor.mjs.

---

## 7. Approval

Operator approved scope and approach on 2026-05-21T02:27:56Z via interactive coordinator session. Implementation proceeds via fleet tasks.
