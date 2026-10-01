"""Tests for probe_endpoint.py bug fixes."""
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from probe_endpoint import probe_html_payload, probe_json_payload


# ---------------------------------------------------------------------------
# Bug 2: probe_html_payload.verified_store_count must always be an int
# ---------------------------------------------------------------------------

def make_json_ld_html(store_type: str, count: int) -> str:
    """Return minimal HTML with JSON-LD store blocks."""
    blocks = "".join(
        f'<script type="application/ld+json">{{"@type": "{store_type}"}}</script>'
        for _ in range(count)
    )
    return f"<html><head>{blocks}</head><body></body></html>"


def test_html_verified_store_count_is_int_when_stores_found():
    html = make_json_ld_html("LocalBusiness", 3)
    result = probe_html_payload("https://example.com/stores", html)
    assert isinstance(result["verified_store_count"], int), (
        f"expected int, got {type(result['verified_store_count'])}"
    )
    assert result["verified_store_count"] == 3
    assert result["verified"] is True


def test_html_verified_store_count_is_int_when_no_stores():
    """verified_store_count must be 0 (int), not None, when no stores detected."""
    html = "<html><body><p>No stores here.</p></body></html>"
    result = probe_html_payload("https://example.com/empty", html)
    assert result["verified_store_count"] is not None, (
        "verified_store_count must never be None"
    )
    assert isinstance(result["verified_store_count"], int), (
        f"expected int, got {type(result['verified_store_count'])}"
    )
    assert result["verified_store_count"] == 0
    assert result["verified"] is False


def test_html_and_json_verified_store_count_same_type():
    """Both probe functions return the same type for verified_store_count."""
    html = "<html><body></body></html>"
    json_payload = {"stores": []}

    html_result = probe_html_payload("https://example.com/a", html)
    json_result = probe_json_payload("https://example.com/b", json_payload)

    assert type(html_result["verified_store_count"]) == type(
        json_result["verified_store_count"]
    ), (
        f"type mismatch: html={type(html_result['verified_store_count'])}, "
        f"json={type(json_result['verified_store_count'])}"
    )


def make_store_records(count: int):
    """Return records that satisfy is_store_like_record (>=2 high-signal fields)."""
    return [
        {"name": f"Store {i}", "city": "Springfield", "address": f"{i} Main St"}
        for i in range(count)
    ]


def test_json_verified_store_count_is_int_when_stores_found():
    payload = {"stores": make_store_records(5)}
    result = probe_json_payload("https://example.com/api/stores", payload)
    assert isinstance(result["verified_store_count"], int), (
        f"expected int, got {type(result['verified_store_count'])}"
    )
    assert result["verified_store_count"] == 5
    assert result["verified"] is True


def test_json_verified_store_count_is_int_when_empty():
    result = probe_json_payload("https://example.com/api/stores", {"stores": []})
    assert isinstance(result["verified_store_count"], int), (
        f"expected int, got {type(result['verified_store_count'])}"
    )
    assert result["verified_store_count"] == 0


# ---------------------------------------------------------------------------
# Live probe tests — call real stored endpoints and validate detection output
# These require network access; skip cleanly when offline.
# ---------------------------------------------------------------------------

import urllib.request

def _network_available() -> bool:
    try:
        urllib.request.urlopen("https://stockist.co", timeout=5)
        return True
    except Exception:
        return False


def test_live_bremont_watches_detection():
    """Bremont uses Stockist SaaS — flat JSON array, no wrapper key."""
    from probe_endpoint import run_probe
    result = run_probe("https://stockist.co/api/v1/u3131/locations/all")
    assert result.success, f"probe failed: {result.endpoint.get('errors')}"
    ep = result.endpoint
    assert ep["type"] == "json", f"expected json, got {ep['type']}"
    assert ep["verified"] is True
    assert isinstance(ep["verified_store_count"], int)
    assert ep["verified_store_count"] > 100, "expected 100+ Bremont stores"
    assert ep["data_path"] == "", "flat array → empty data_path"
    assert "name" in ep["field_mapping"]
    assert "latitude" in ep["field_mapping"]
    assert "longitude" in ep["field_mapping"]


def test_live_aerowatch_detection():
    """Aerowatch AJAX endpoint — flat JSON array with custom X-Requested-With header."""
    from probe_endpoint import run_probe
    result = run_probe("https://www.aerowatch.com/en/stockists/ajax/stores")
    assert result.success, f"probe failed: {result.endpoint.get('errors')}"
    ep = result.endpoint
    assert ep["type"] == "json"
    assert ep["verified"] is True
    assert ep["verified_store_count"] > 200
    assert ep["data_path"] == ""
    assert "name" in ep["field_mapping"]
    assert "city" in ep["field_mapping"]


def test_live_mondaine_detection():
    """Mondaine uses StoreMapper SaaS — JSON with top-level 'stores' wrapper."""
    from probe_endpoint import run_probe
    result = run_probe("https://storemapper.co/api/users/6698/stores.json")
    assert result.success, f"probe failed: {result.endpoint.get('errors')}"
    ep = result.endpoint
    assert ep["type"] == "json"
    assert ep["verified"] is True
    assert ep["verified_store_count"] > 1000
    assert ep["data_path"] == "stores", f"expected data_path='stores', got '{ep['data_path']}'"
    assert "name" in ep["field_mapping"]


def test_live_detection_verified_store_count_always_int():
    """All live-probe results return int (not None) for verified_store_count."""
    from probe_endpoint import run_probe
    urls = [
        "https://stockist.co/api/v1/u3131/locations/all",
        "https://www.aerowatch.com/en/stockists/ajax/stores",
        "https://storemapper.co/api/users/6698/stores.json",
    ]
    for url in urls:
        result = run_probe(url)
        ep = result.endpoint
        assert isinstance(ep["verified_store_count"], int), (
            f"{url}: verified_store_count is {type(ep['verified_store_count'])}, not int"
        )


if __name__ == "__main__":
    unit_tests = [
        test_html_verified_store_count_is_int_when_stores_found,
        test_html_verified_store_count_is_int_when_no_stores,
        test_html_and_json_verified_store_count_same_type,
        test_json_verified_store_count_is_int_when_stores_found,
        test_json_verified_store_count_is_int_when_empty,
    ]
    live_tests = [
        test_live_bremont_watches_detection,
        test_live_aerowatch_detection,
        test_live_mondaine_detection,
        test_live_detection_verified_store_count_always_int,
    ]

    print("=== Unit tests ===")
    passed = 0
    for t in unit_tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except Exception as exc:
            print(f"  FAIL  {t.__name__}: {exc}")

    print(f"\n=== Live endpoint tests ===")
    if not _network_available():
        print("  SKIP  (no network)")
        live_passed = len(live_tests)
    else:
        live_passed = 0
        for t in live_tests:
            try:
                t()
                print(f"  PASS  {t.__name__}")
                live_passed += 1
            except Exception as exc:
                print(f"  FAIL  {t.__name__}: {exc}")

    total = len(unit_tests) + len(live_tests)
    total_passed = passed + live_passed
    print(f"\n{total_passed}/{total} passed")
    sys.exit(0 if total_passed == total else 1)
