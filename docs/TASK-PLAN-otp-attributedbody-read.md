# TASK PLAN: otp-attributedbody-read (fleet slug: fix-sms-imessage-py-to-r-7114)

**Parent design:** [docs/DESIGN-discord-cron-otp-and-heartbeat-fix.md](./DESIGN-discord-cron-otp-and-heartbeat-fix.md)
**Approved:** 2026-05-21T02:27:56Z
**Priority:** P1 — blocks tomorrow's scheduled cron run.

---

## Goal (one line)

Make `src/sms_imessage.py` extract the OTP code from `message.attributedBody` so cron OTP polling stops missing USCIS SMS on macOS 13+ when `message.text` is NULL.

---

## Acceptance criteria

1. `src/sms_imessage.py` reads rows where `attributedBody IS NOT NULL` in addition to `text LIKE` matches.
2. A pure function `extract_code_from_row(text, attributed_body, code_regex, keywords) -> str | None` exists and is unit-tested.
3. `tests/test_sms_imessage.py` passes for all 4 captured fixtures:
   - `2026-05-20T06-00-08_uscis_145950.hex` → returns `"145950"`
   - `2026-05-20T12-05-30_uscis_983284.hex` → returns `"983284"`
   - `2026-05-20T19-22-42_uscis_447431.hex` → returns `"447431"`
   - `2026-05-20T11-57-58_apartment_NEGATIVE.hex` → returns `None`
4. The existing `--config-json` CLI surface is unchanged; existing call sites in `src/monitor.mjs` keep working.
5. End-to-end smoke (manual on the operator's Mac after the worker lands the PR): operator runs `node src/monitor.mjs login`, the OTP is extracted from the latest USCIS SMS regardless of whether it lives in `text` or `attributedBody`.
6. No new Python dependencies. Standard library only.

---

## Expected files & surfaces

**Modify:**
- `src/sms_imessage.py`
  - SQL: broaden `WHERE` to include `attributedBody IS NOT NULL`.
  - SELECT: add `m.attributedBody` to the projection.
  - New function `extract_printable_runs(blob: bytes, min_run: int = 4) -> str` — scans `blob` and joins runs of printable ASCII (`0x20`–`0x7E`) of length ≥ `min_run`, separated by single spaces.
  - New function `extract_code_from_row(text, attributed_body, code_regex_compiled, keywords) -> str | None` — builds the haystack (`text` if present, then a space, then `extract_printable_runs(attributed_body)` if present), checks any keyword appears (case-insensitive), runs `code_regex_compiled.search(haystack)`, returns the captured group.
  - Rewire `poll_for_code_from_messages` to call `extract_code_from_row` per row, kept-newest selection logic unchanged.
  - Keywords constant: `("verification", "uscis", "secure")` (lowercase comparison).

**Create:**
- `tests/test_sms_imessage.py` — pytest tests for the two new pure functions.
- `tests/__init__.py` (empty, so pytest discovers the package).
- `tests/conftest.py` — `FIXTURES = Path(__file__).parent / "fixtures" / "sms_attributedbody"` helper.

**Already exists (worker just reads):**
- `tests/fixtures/sms_attributedbody/*.hex` (4 files, captured 2026-05-21).

**Don't touch:**
- `src/monitor.mjs` — out of scope for this task (Bug B has its own task).
- `src/email_otp.py` — out of scope.
- Anything in `state/` or `snapshots/`.

---

## Test plan

```bash
# from repo root
python3 -m pip install --user pytest   # if missing
python3 -m pytest tests/ -q -v
```

Expected: 4 tests pass, 0 fail.

The worker MUST run this locally before opening the PR.

No new CI is in scope; this project has no CI configuration today.

---

## Implementation notes (concrete starter)

The printable-ASCII extraction can be as simple as:

```python
def extract_printable_runs(blob: bytes, min_run: int = 4) -> str:
    if not blob:
        return ""
    out, run = [], bytearray()
    for b in blob:
        if 0x20 <= b <= 0x7E:
            run.append(b)
        else:
            if len(run) >= min_run:
                out.append(run.decode("ascii"))
            run.clear()
    if len(run) >= min_run:
        out.append(run.decode("ascii"))
    return " ".join(out)
```

Loading a fixture in tests:

```python
def load_blob(name):
    return bytes.fromhex((FIXTURES / name).read_text().strip())
```

The 06:00 and 12:05 fixtures have `text=None`; pass `None` for the `text` argument to mirror reality.

---

## Non-goals

- Wiring email_otp.py as a fallback.
- Touching monitor.mjs.
- Adding CI.
- Refactoring `poll_for_code_from_messages` beyond the row-loop change.

---

## Dependencies

None upstream. Bug B's task (`stop-losing-discord-hear-b048`) depends on THIS task landing first (so the new PR's tests don't get blamed for an unrelated heartbeat regression).
