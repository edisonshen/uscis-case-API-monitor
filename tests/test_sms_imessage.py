"""Tests for the OTP extraction logic in ``src/sms_imessage.py``.

These tests exercise the pure functions only — no SQLite, no network, no
macOS dependency. The fixtures under ``tests/fixtures/sms_attributedbody``
are hex-encoded snapshots of the ``message.attributedBody`` blob from the
operator's macOS Messages DB captured on 2026-05-20.
"""

from __future__ import annotations

import re

import pytest

from sms_imessage import (
    OTP_KEYWORDS,
    extract_code_from_row,
    extract_printable_runs,
)
from tests.conftest import FIXTURES


CODE_REGEX = re.compile(r"\b(\d{6})\b")


def load_blob(name: str) -> bytes:
    """Load a hex-encoded fixture as raw bytes."""
    return bytes.fromhex((FIXTURES / name).read_text().strip())


# ---------------------------------------------------------------------------
# extract_code_from_row — the main acceptance criteria
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "fixture_name,expected_code",
    [
        # text=NULL on the live DB row; code lives only in the blob.
        ("2026-05-20T06-00-08_uscis_145950.hex", "145950"),
        ("2026-05-20T12-05-30_uscis_983284.hex", "983284"),
    ],
)
def test_extracts_code_when_text_is_null(fixture_name: str, expected_code: str) -> None:
    blob = load_blob(fixture_name)
    code = extract_code_from_row(None, blob, CODE_REGEX)
    assert code == expected_code


def test_extracts_code_when_text_is_populated() -> None:
    """Regression: when m.text is populated (macOS <13 fast path / lucky
    macOS 13+ row), we still pull the same code and don't double-extract."""
    blob = load_blob("2026-05-20T19-22-42_uscis_447431.hex")
    text = (
        "447431 is the secure verification code for logging into your "
        "USCIS Online Account."
    )
    code = extract_code_from_row(text, blob, CODE_REGEX)
    assert code == "447431"


def test_returns_none_for_non_uscis_message() -> None:
    """Negative: an apartment-renewal SMS contains no OTP keyword and must
    not surface a code even though the blob contains digit sequences (a
    date like ``09/30/2026``). The keyword gate is what protects us from
    extracting bogus codes from unrelated messages."""
    blob = load_blob("2026-05-20T11-57-58_apartment_NEGATIVE.hex")
    assert extract_code_from_row(None, blob, CODE_REGEX) is None


# ---------------------------------------------------------------------------
# extract_printable_runs — helper-level coverage
# ---------------------------------------------------------------------------


def test_printable_runs_empty_inputs() -> None:
    assert extract_printable_runs(None) == ""
    assert extract_printable_runs(b"") == ""


def test_printable_runs_drops_short_noise() -> None:
    # b"\x00abc\x00DEFG\x00" => "abc" is dropped (len 3 < min_run=4),
    # "DEFG" is kept.
    assert extract_printable_runs(b"\x00abc\x00DEFG\x00") == "DEFG"


def test_printable_runs_recovers_full_uscis_text() -> None:
    blob = load_blob("2026-05-20T06-00-08_uscis_145950.hex")
    recovered = extract_printable_runs(blob)
    # Sanity: the literal SMS body is recoverable from the blob.
    assert "145950 is the secure verification code" in recovered
    assert "USCIS Online Account" in recovered


# ---------------------------------------------------------------------------
# OTP_KEYWORDS shape — guard against accidental mutation
# ---------------------------------------------------------------------------


def test_keywords_are_lowercase_tuple() -> None:
    assert isinstance(OTP_KEYWORDS, tuple)
    assert all(kw == kw.lower() for kw in OTP_KEYWORDS)
    assert "verification" in OTP_KEYWORDS
    assert "uscis" in OTP_KEYWORDS
