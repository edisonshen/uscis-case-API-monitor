"""Shared pytest fixtures and path helpers for the test suite."""

from __future__ import annotations

import sys
from pathlib import Path

# Make ``src/`` importable as a top-level package without installing the
# project. ``sms_imessage`` is a script-style module living under src/.
REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = REPO_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

FIXTURES = Path(__file__).parent / "fixtures" / "sms_attributedbody"
