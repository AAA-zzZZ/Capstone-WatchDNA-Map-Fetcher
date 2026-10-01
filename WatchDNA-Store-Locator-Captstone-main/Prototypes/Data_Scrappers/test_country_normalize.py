#!/usr/bin/env python3
"""Unit tests for country_normalize.normalize_country."""

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from country_normalize import normalize_country


def run_tests():
    cases = [
        # ISO alpha-2 codes — via JSON (watch_store_countries.json)
        ("US", "United States"),
        ("us", "United States"),
        ("GB", "United Kingdom"),
        ("FR", "France"),
        ("DE", "Germany"),
        ("JP", "Japan"),
        ("CN", "China"),
        ("HK", "Hong Kong"),           # JSON overrides pycountry
        ("TW", "Taiwan"),              # JSON overrides pycountry ("Taiwan, Province of China")
        ("KR", "South Korea"),         # JSON overrides pycountry ("Korea, Republic of")
        ("CZ", "Czech Republic"),      # JSON overrides pycountry ("Czechia")
        ("CH", "Switzerland"),

        # ISO alpha-2 codes — via pycountry only (not in JSON)
        ("AD", "Andorra"),
        ("LI", "Liechtenstein"),
        ("MC", "Monaco"),

        # Aliases
        ("USA", "United States"),
        ("U.S.", "United States"),
        ("U.S.A.", "United States"),
        ("United States of America", "United States"),
        ("UK", "United Kingdom"),
        ("U.K.", "United Kingdom"),
        ("Great Britain", "United Kingdom"),
        ("England", "United Kingdom"),
        ("Scotland", "United Kingdom"),
        ("UAE", "United Arab Emirates"),
        ("U.A.E.", "United Arab Emirates"),
        ("Korea", "South Korea"),
        ("Republic of Korea", "South Korea"),
        ("Czechia", "Czech Republic"),
        ("HK", "Hong Kong"),
        ("Taiwan, Province of China", "Taiwan"),

        # Full names — canonical casing from JSON
        ("france", "France"),
        ("FRANCE", "France"),
        ("united states", "United States"),
        ("south korea", "South Korea"),
        ("hong kong", "Hong Kong"),

        # Already correct — passthrough unchanged
        ("United States", "United States"),
        ("Switzerland", "Switzerland"),
        ("Andorra", "Andorra"),

        # Empty / whitespace
        ("", ""),
        ("   ", ""),
    ]

    passed = 0
    failed = 0
    for inp, expected in cases:
        result = normalize_country(inp)
        ok = result == expected
        if ok:
            passed += 1
        else:
            failed += 1
            print(f"FAIL  {inp!r:40} -> {result!r}  (expected {expected!r})")

    print(f"\n{passed}/{passed + failed} tests passed", end="")
    if failed:
        print(f"  ({failed} FAILED)")
        sys.exit(1)
    else:
        print()


if __name__ == "__main__":
    run_tests()
