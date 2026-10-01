#!/usr/bin/env python3
"""
Dry-run scrape for brand configs: no geocoding, keep all normalized rows, scan text for HTML/entity junk.

Default mode only runs JSON brands without expansion flags or viewport-style URLs (fast).
Use --include-heavy for viewport/country/geohash/catalog brands (slow, many HTTP calls).

Run from repo root or from Prototypes/Data_Scrappers:

  python3 dev_tools/dry_run_quality.py
  python3 dev_tools/dry_run_quality.py --brands frederique_constant_stores,glashuette_original_stores
"""

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from typing import List, Optional, Tuple

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from universal_scraper import universal_scrape  # noqa: E402

CONFIG_PATH = os.path.join(ROOT, "brand_configs.json")

TEMPLATE_MARKERS = (
    "yourbrand.com",
    "myshopify.com",
    "yourwebsite.com",
    "api.yourbrand",
    "yourstore.",
)

EXPANSION_KEYS = (
    "worldwide_country_pagination",
    "geohash_prefix_expansion",
    "stores_by_api_countries",
    "pagination_fetch_urls",
    "force_radius_multi_point",
)

VIEWPORT_MARKERS = ("northEastLat", "southWestLat")

HTML_ENTITY_RE = re.compile(r"&#\d+;|&#x[0-9a-fA-F]+;|&[a-zA-Z]{2,31};")
PLUS_CODE_RE = re.compile(r"\b[A-Z0-9]{4,8}\+[A-Z0-9]{2,5}\b", re.I)


def should_skip_brand(brand_id: str, cfg: dict, include_heavy: bool) -> Tuple[bool, str]:
    if brand_id.startswith("_"):
        return True, "meta"
    if cfg.get("enabled") is False:
        return True, "enabled false"
    url = cfg.get("url") or ""
    for m in TEMPLATE_MARKERS:
        if m in url:
            return True, "template url"
    if include_heavy:
        return False, ""
    if cfg.get("type") != "json":
        return True, "non-json (use --include-heavy)"
    for k in EXPANSION_KEYS:
        if cfg.get(k):
            return True, f"expansion {k}"
    for m in VIEWPORT_MARKERS:
        if m in url:
            return True, "viewport url"
    return False, ""


def scan_row(row: dict) -> List[Tuple[str, str, str]]:
    issues: List[Tuple[str, str, str]] = []
    text_cols = (
        "Name",
        "Address Line 1",
        "Address Line 2",
        "City",
        "State/Province/Region",
        "Country",
        "Postal/ZIP Code",
    )
    for col in text_cols:
        v = (row.get(col) or "").strip()
        if not v:
            continue
        if HTML_ENTITY_RE.search(v):
            issues.append(("html_entity", col, v[:200]))
        if re.search(r"<[a-zA-Z!?/]", v):
            issues.append(("html_tag", col, v[:200]))
        if re.search(r"\s{3,}", v):
            issues.append(("multi_space", col, v[:200]))
    addr1 = (row.get("Address Line 1") or "").strip()
    city = (row.get("City") or "").strip()
    if city and not addr1:
        issues.append(("empty_address_with_city", "Address Line 1", f"city={city[:100]}"))
    if ",,," in addr1:
        issues.append(("triple_comma", "Address Line 1", addr1[:200]))
    name = (row.get("Name") or "").strip()
    if "\\n" in addr1 or "\\n" in name or "\\t" in addr1:
        issues.append(("literal_escape", "text", (addr1 or name)[:200]))
    if (
        addr1
        and city
        and PLUS_CODE_RE.search(addr1)
        and addr1.lower().count(city.lower().strip()) >= 2
    ):
        issues.append(("plus_code_dup_city_in_line1", "Address Line 1", addr1[:200]))
    return issues


def resolve_force_type(brand_config: Optional[dict]) -> Optional[str]:
    """Match universal_scraper.py main() so programmatic calls behave like CLI."""
    if not brand_config:
        return None
    _norm = {"json": "single_call", "html": "single_call"}
    cfg_type = brand_config.get("type", "")
    if not cfg_type:
        return None
    if cfg_type == "json" and brand_config.get("worldwide_country_pagination"):
        return "country_filter"
    if cfg_type == "json" and brand_config.get("geohash_prefix_expansion"):
        return None
    return _norm.get(cfg_type, cfg_type)


def run_one(brand_id: str, cfg: dict) -> dict:
    url = cfg.get("url")
    if not url:
        return {"brand": brand_id, "error": "no url", "rows": 0, "issues": []}

    force_type = resolve_force_type(cfg)

    with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w", encoding="utf-8") as tmp:
        out_path = tmp.name

    try:
        res = universal_scrape(
            url=url,
            output_file=out_path,
            region="world",
            force_type=force_type,
            validate_output=False,
            brand_config=cfg,
            dry_run=True,
        )
    except Exception as e:
        os.unlink(out_path)
        return {"brand": brand_id, "error": str(e), "rows": 0, "issues": []}

    issues: List[dict] = []
    row_count = 0
    if res.get("success") and os.path.isfile(out_path):
        with open(out_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                row_count += 1
                for kind, col, sample in scan_row(row):
                    issues.append(
                        {"row": row_count, "kind": kind, "column": col, "sample": sample}
                    )
    try:
        os.unlink(out_path)
        dropped = out_path.rsplit(".csv", 1)[0] + "_dropped.json"
        if os.path.isfile(dropped):
            os.unlink(dropped)
    except OSError:
        pass

    return {
        "brand": brand_id,
        "error": None if res.get("success") else "scrape failed",
        "detected_type": res.get("detected_type"),
        "stores_found": res.get("stores_found", 0),
        "stores_normalized": res.get("stores_normalized", 0),
        "rows_scanned": row_count,
        "warnings": res.get("warnings") or [],
        "issues": issues[:500],
        "issue_truncated": len(issues) > 500,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Dry-run scraper QA (text/address heuristics)")
    parser.add_argument(
        "--include-heavy",
        action="store_true",
        help="Include viewport/country/geohash/catalog JSON brands (slow)",
    )
    parser.add_argument("--brands", help="Comma-separated brand ids (overrides mode filter)")
    args = parser.parse_args()

    with open(CONFIG_PATH, encoding="utf-8") as f:
        all_cfg = json.load(f)

    explicit = None
    if args.brands:
        explicit = {b.strip() for b in args.brands.split(",") if b.strip()}

    to_run: List[Tuple[str, dict]] = []
    skipped: List[Tuple[str, str]] = []

    for bid, cfg in sorted(all_cfg.items()):
        if not isinstance(cfg, dict):
            continue
        if explicit is not None:
            if bid not in explicit:
                continue
        else:
            skip, reason = should_skip_brand(bid, cfg, args.include_heavy)
            if skip:
                skipped.append((bid, reason))
                continue
        to_run.append((bid, cfg))

    print(f"Brands to dry-run: {len(to_run)}  (skipped: {len(skipped)})")
    print()

    total_issues = 0
    summaries: List[dict] = []
    for bid, cfg in to_run:
        print(f"--- {bid} ---", flush=True)
        s = run_one(bid, cfg)
        summaries.append(s)
        ni = len(s.get("issues") or [])
        total_issues += ni
        if s.get("error"):
            print(f"  ERROR: {s['error']}", flush=True)
        else:
            print(
                f"  found={s.get('stores_found')} normalized={s.get('stores_normalized')} "
                f"rows_csv={s.get('rows_scanned')} type={s.get('detected_type')}",
                flush=True,
            )
        if s.get("warnings"):
            for w in s["warnings"][:5]:
                print(f"  pipeline: {w}", flush=True)
        if ni:
            print(f"  text QA flags: {ni}" + (" (truncated)" if s.get("issue_truncated") else ""), flush=True)
            for it in s["issues"][:15]:
                print(
                    f"    row {it['row']} {it['kind']} [{it['column']}]: {it['sample']!r}",
                    flush=True,
                )
            if ni > 15:
                print(f"    ... and {ni - 15} more", flush=True)
        print(flush=True)

    print("=" * 72)
    print(f"Done. {len(to_run)} brand(s), {total_issues} total heuristic flag(s).")
    if explicit is None and skipped:
        print(f"Skipped {len(skipped)} brand(s) (templates, non-json, or expansion).")
        print("  Re-run with --include-heavy and/or --brands id1,id2 to cover more.")
    ok = bool(summaries) and all(not s.get("error") for s in summaries)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
