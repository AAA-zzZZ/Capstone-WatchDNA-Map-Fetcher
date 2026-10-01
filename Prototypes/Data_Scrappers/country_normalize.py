#!/usr/bin/env python3
"""
Country name normalization utility.

Converts raw country values (ISO alpha-2 codes, aliases, abbreviations, or free-form
names) to a single canonical English full name.

Resolution order for any input value:
  1. Known aliases (e.g. "USA", "UK", "UAE") → canonical full name
  2. 2-letter ISO alpha-2 code → look up in watch_store_countries.json first
     (preserves project-preferred names like "South Korea"), then fall back to pycountry
  3. Full-name values → case-insensitive match against JSON values for canonical spelling
  4. Unrecognised values → returned unchanged (original casing preserved)

The JSON lookup table is loaded once at import time.
"""

import os
import re
import json
from typing import Optional

# ── Module-level JSON cache ────────────────────────────────────────────────────

_JSON_CODES: dict[str, str] = {}   # "US" → "United States"
_JSON_NAMES: dict[str, str] = {}   # "united states" → "United States"

def _load_json() -> None:
    """Load watch_store_countries.json into module-level dicts (idempotent)."""
    global _JSON_CODES, _JSON_NAMES
    if _JSON_CODES:
        return  # already loaded
    countries_file = os.path.join(os.path.dirname(__file__), "watch_store_countries.json")
    try:
        with open(countries_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        codes = data.get("countries", {})
        _JSON_CODES = {k.upper(): v for k, v in codes.items()}
        _JSON_NAMES = {v.lower(): v for v in codes.values()}
    except Exception:
        pass  # graceful degradation — pycountry still works


_load_json()

# ── Alias table ────────────────────────────────────────────────────────────────
# Maps common abbreviations / alternate spellings to canonical full names.
# These always win over any code-based lookup, so project-preferred names
# for contested cases (England → United Kingdom) live here.

_ALIASES: dict[str, str] = {
    # United States
    "usa": "United States",
    "u.s.": "United States",
    "u.s.a.": "United States",
    "united states of america": "United States",
    # United Kingdom
    "uk": "United Kingdom",
    "u.k.": "United Kingdom",
    "great britain": "United Kingdom",
    "britain": "United Kingdom",
    "england": "United Kingdom",
    "scotland": "United Kingdom",
    "wales": "United Kingdom",
    "northern ireland": "United Kingdom",
    # United Arab Emirates
    "uae": "United Arab Emirates",
    "u.a.e.": "United Arab Emirates",
    # South Korea
    "korea": "South Korea",
    "republic of korea": "South Korea",
    # Czech Republic (project uses "Czech Republic" not "Czechia")
    "czechia": "Czech Republic",
    # Hong Kong
    "hk": "Hong Kong",
    # Macau
    "macao": "Macau",
    # Taiwan
    "taiwan, province of china": "Taiwan",
    "chinese taipei": "Taiwan",
    # Russia
    "russian federation": "Russia",
    # Iran
    "iran, islamic republic of": "Iran",
    # Syria
    "syrian arab republic": "Syria",
    # Vietnam
    "viet nam": "Vietnam",
    # South Africa
    "rsa": "South Africa",
    # South America
    "brasil": "Brazil",
}

# ── Core helper ────────────────────────────────────────────────────────────────

def normalize_country(value: str) -> str:
    """
    Return the canonical English country name for *value*.

    - Empty / whitespace → returns ""
    - Alias match (case-insensitive) → canonical alias target
    - 2-letter alpha-2 code → JSON lookup, then pycountry
    - Full name → JSON canonical-spelling lookup, then unchanged
    """
    if not value:
        return ""

    stripped = value.strip()
    if not stripped:
        return ""

    lower = stripped.lower()

    # 1. Alias check
    alias_result = _ALIASES.get(lower)
    if alias_result:
        return alias_result

    # 2. ISO alpha-2 code (exactly 2 letters, no digits or punctuation)
    if re.fullmatch(r"[A-Za-z]{2}", stripped):
        code = stripped.upper()

        # JSON first (project-preferred names)
        json_result = _JSON_CODES.get(code)
        if json_result:
            return json_result

        # Fall back to pycountry for codes not in our JSON (e.g. AD → Andorra)
        try:
            import pycountry
            country_obj = pycountry.countries.get(alpha_2=code)
            if country_obj:
                # Check if pycountry's name has a cleaner alias
                pc_name_lower = country_obj.name.lower()
                alias_for_pc = _ALIASES.get(pc_name_lower)
                return alias_for_pc if alias_for_pc else country_obj.name
        except ImportError:
            pass

        # Unknown 2-letter code — return as-is
        return stripped

    # 3. Full-name canonicalization against JSON values (case-insensitive)
    json_canon = _JSON_NAMES.get(lower)
    if json_canon:
        return json_canon

    # 4. No match — return the trimmed original
    return stripped
