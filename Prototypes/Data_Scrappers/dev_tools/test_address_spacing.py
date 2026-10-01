#!/usr/bin/env python3
"""Scan output CSVs for address spacing issues and test clean_address fix."""
import csv
import os
import re
from data_normalizer import clean_address, normalize_location

OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
ADDR1_COL = "Address Line 1"

SPACING_ISSUE_PATTERN = re.compile(r"[a-zA-Z]\d|\d[a-zA-Z]")


def has_spacing_issue(addr: str) -> bool:
    if not addr or not addr.strip():
        return False
    return bool(SPACING_ISSUE_PATTERN.search(addr))


def find_examples():
    examples = []
    for fname in sorted(os.listdir(OUTPUT_DIR)):
        if not fname.endswith(".csv"):
            continue
        path = os.path.join(OUTPUT_DIR, fname)
        try:
            with open(path, newline="", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                if ADDR1_COL not in reader.fieldnames:
                    continue
                for row in reader:
                    addr = (row.get(ADDR1_COL) or "").strip()
                    if addr and has_spacing_issue(addr):
                        examples.append({
                            "file": fname,
                            "name": row.get("Name", ""),
                            "city": row.get("City", ""),
                            "addr_before": addr,
                        })
        except Exception as e:
            print(f"  Skip {fname}: {e}")
    return examples


def main():
    print("Scanning output/*.csv for address spacing issues...\n")
    examples = find_examples()

    seen = set()
    unique = []
    for ex in examples:
        key = ex["addr_before"]
        if key not in seen:
            seen.add(key)
            unique.append(ex)

    fixed = []
    for ex in unique:
        after = clean_address(ex["addr_before"])
        if ex["addr_before"] != after:
            ex["addr_after"] = after
            fixed.append(ex)

    print(f"Found {len(examples)} rows with letter+digit patterns ({len(unique)} unique)")
    print(f"Of those, {len(fixed)} get FIXED by clean_address (conservative: word+number, number+word)\n")
    print("=" * 80)
    print("EXAMPLES THAT GET FIXED (before -> after)")
    print("=" * 80)

    for i, ex in enumerate(fixed[:20], 1):
        print(f"\n{i}. {ex['file']} | {ex['name'][:40]} | {ex['city']}")
        print(f"   BEFORE: {ex['addr_before']}")
        print(f"   AFTER:  {ex['addr_after']}")

    if not fixed:
        print("\n(No addresses in output matched the fix pattern - run with Omega data for Junction500-style examples)")

    print("\n" + "=" * 80)
    print("FULL NORMALIZE TEST (first 5 fixed)")
    print("=" * 80)
    for i, ex in enumerate(fixed[:5], 1):
        raw = {
            "Name": ex["name"],
            "Address Line 1": ex["addr_before"],
            "City": ex["city"],
        }
        norm = normalize_location(raw, None)
        print(f"\n{i}. {ex['name'][:50]}")
        print(f"   Input:  {ex['addr_before']}")
        print(f"   Output: {norm.get('Address Line 1', '')}")


if __name__ == "__main__":
    main()
