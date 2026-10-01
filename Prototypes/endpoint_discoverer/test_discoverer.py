#!/usr/bin/env python3
"""Pytest suite for the endpoint discoverer.

Run with:
    cd Prototypes/endpoint_discoverer
    pytest test_discoverer.py -v

Each test uses a real store-locator page from a brand already in brand_configs.json,
verifies that the discoverer succeeds, and checks that the discovered endpoint/config
matches what we already know works.
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from endpoint_discoverer import EndpointDiscoverer


def _make_discoverer() -> EndpointDiscoverer:
    return EndpointDiscoverer(headless=True, timeout=30, verify_endpoints=True)


def _top_endpoint(result: dict) -> dict:
    """Return the highest-confidence endpoint from a discovery result."""
    endpoints = result.get('endpoints', [])
    return endpoints[0] if endpoints else {}


# ---------------------------------------------------------------------------
# A. Lange & Söhne — single-call JSON API
# ---------------------------------------------------------------------------

class TestAlangeSoehne:
    """The store locator page at alange-soehne.com triggers a single JSON API call
    that returns all stores.  The discoverer must find a URL containing
    /api/search/store/locator and suggest a 'json' config."""

    STORE_LOCATOR_URL = "https://www.alange-soehne.com/us-en/store-locator"
    EXPECTED_API_FRAGMENT = "/api/search/store/locator"

    def test_discovery_succeeds(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert result['success'] is True, f"Discovery failed: {result.get('errors')}"

    def test_endpoints_found(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert len(result['endpoints']) > 0, "No endpoints discovered"

    def test_correct_api_url_found(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        urls = [ep.get('url', '') for ep in result['endpoints']]
        assert any(self.EXPECTED_API_FRAGMENT in u for u in urls), (
            f"Expected fragment '{self.EXPECTED_API_FRAGMENT}' not found in: {urls}"
        )

    def test_suggested_config_is_json(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        cfg = result.get('suggested_config') or {}
        assert cfg.get('type') == 'json', f"Expected type 'json', got: {cfg.get('type')}"

    def test_top_endpoint_has_stores(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        top = _top_endpoint(result)
        store_count = top.get('verified_store_count') or top.get('store_count') or 0
        assert store_count > 0, f"Expected stores in top endpoint, got: {top}"


# ---------------------------------------------------------------------------
# Rolex — related-domain viewport API
# ---------------------------------------------------------------------------

class TestRolex:
    """Rolex's store locator is on www.rolex.com but the API lives on
    retailers.rolex.com.  The discoverer must find the related-domain API."""

    STORE_LOCATOR_URL = "https://www.rolex.com/en-us/retailers"
    EXPECTED_DOMAIN_FRAGMENT = "retailers.rolex.com"

    def test_discovery_succeeds(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert result['success'] is True, f"Discovery failed: {result.get('errors')}"

    def test_endpoints_found(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert len(result['endpoints']) > 0, "No endpoints discovered"

    def test_retailers_domain_discovered(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        urls = [ep.get('url', '') for ep in result['endpoints']]
        assert any(self.EXPECTED_DOMAIN_FRAGMENT in u for u in urls), (
            f"Expected domain '{self.EXPECTED_DOMAIN_FRAGMENT}' not found in: {urls}"
        )

    def test_suggested_config_present(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert result.get('suggested_config') is not None, "No suggested config returned"


# ---------------------------------------------------------------------------
# Alpina — radius-based JSON endpoint
# ---------------------------------------------------------------------------

class TestAlpina:
    """Alpina uses a Demandware radius-based JSON endpoint.
    The discoverer must find a URL containing FindStores and classify it
    as radius or json type."""

    STORE_LOCATOR_URL = "https://us.alpinawatches.com/store-locator"
    EXPECTED_API_FRAGMENT = "FindStores"

    def test_discovery_succeeds(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert result['success'] is True, f"Discovery failed: {result.get('errors')}"

    def test_endpoints_found(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert len(result['endpoints']) > 0, "No endpoints discovered"

    def test_findstores_endpoint_discovered(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        urls = [ep.get('url', '') for ep in result['endpoints']]
        assert any(self.EXPECTED_API_FRAGMENT in u for u in urls), (
            f"Expected fragment '{self.EXPECTED_API_FRAGMENT}' not found in: {urls}"
        )

    def test_suggested_config_present(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        assert result.get('suggested_config') is not None, "No suggested config returned"


# ---------------------------------------------------------------------------
# Omega — HTML page (large, 1400+ stores)
# Verifies that the discoverer does NOT time out / hang on large HTML pages.
# ---------------------------------------------------------------------------

class TestOmega:
    """Omega's store locator is a large HTML page with 1400+ stores embedded.
    The discoverer must complete without timing out and correctly identify
    it as an HTML endpoint."""

    STORE_LOCATOR_URL = "https://www.omegawatches.com/en-us/store-locator"

    def test_discovery_completes(self):
        """Discovery must finish (not hang) even with a very large HTML page."""
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        # Success or failure is acceptable; what matters is it completes
        assert isinstance(result, dict)
        assert 'success' in result

    def test_html_type_identified(self):
        discoverer = _make_discoverer()
        result = discoverer.discover(self.STORE_LOCATOR_URL)
        endpoints = result.get('endpoints', [])
        html_analysis = result.get('html_analysis')
        # Either html_analysis is populated OR an html-type endpoint is found
        has_html_signal = (
            html_analysis is not None
            or any(ep.get('type') == 'html' for ep in endpoints)
        )
        assert has_html_signal, (
            "Expected html_analysis or an html-type endpoint for Omega"
        )


class TestCquotientFiltering:
    """CQuotient / Einstein beacons are not store APIs; they must not dominate ranking."""

    def test_network_analyzer_skips_cquotient(self):
        from network_analyzer import NetworkAnalyzer

        na = NetworkAnalyzer()
        beacon = (
            "https://p.cquotient.com/einstein/v3/activities"
            "?activityType=viewPage&siteId=chopard&json=%7B%22foo%22%3A1%7D"
        )
        assert na._should_skip_url(beacon) is True

    def test_unverified_api_sorts_above_low_count_beacon_verification(self):
        from endpoint_verifier import (
            _is_suspected_tracking_or_personalization_url,
            _MIN_STORES_TO_TRUST_SUSPICIOUS_HOST,
        )

        def _rank_after_verify(ep: dict) -> tuple:
            url = ep.get("url") or ""
            sc = ep.get("verified_store_count") or 0
            conf = float(ep.get("confidence") or 0)
            verified_ok = bool(ep.get("verified")) and sc > 0
            suspicious = _is_suspected_tracking_or_personalization_url(url)
            junk_verified = (
                verified_ok
                and suspicious
                and sc < _MIN_STORES_TO_TRUST_SUSPICIOUS_HOST
            )
            if verified_ok and not junk_verified:
                group = 2
            elif not verified_ok:
                group = 1
            else:
                group = 0
            return (group, conf, sc)

        endpoints = [
            {
                "url": "https://p.cquotient.com/x?activityType=viewPage",
                "verified": True,
                "verified_store_count": 2,
                "confidence": 0.85,
            },
            {
                "url": "https://api.brand.com/s/site/dw/shop/v22_6/stores",
                "verified": False,
                "verified_store_count": 0,
                "confidence": 0.72,
            },
        ]
        endpoints.sort(key=_rank_after_verify, reverse=True)
        assert "dw/shop" in endpoints[0]["url"]
