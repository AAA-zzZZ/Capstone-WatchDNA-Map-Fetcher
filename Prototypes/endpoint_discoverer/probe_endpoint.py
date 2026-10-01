#!/usr/bin/env python3
"""Probe a manually entered store-locator endpoint without Selenium."""

import argparse
import json
import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import requests


STORE_KEYWORDS = {
    "store",
    "stores",
    "location",
    "locations",
    "dealer",
    "dealers",
    "retailer",
    "retailers",
    "boutique",
    "boutiques",
    "shop",
    "shops",
}


FIELD_SYNONYMS: Dict[str, Sequence[str]] = {
    "name": ("name", "store_name", "title", "location_name"),
    "address": ("address", "street", "street_address", "line1", "address1"),
    "city": ("city", "town", "locality"),
    "state": ("state", "province", "region"),
    "postal_code": ("zip", "zipcode", "postal", "postal_code"),
    "country": ("country", "country_code"),
    "latitude": ("lat", "latitude", "geo_lat"),
    "longitude": ("lng", "lon", "long", "longitude", "geo_lng"),
    "phone": ("phone", "telephone", "tel"),
    "website": ("url", "website", "store_url", "link"),
}


@dataclass
class ProbeResult:
    success: bool
    endpoint: Dict[str, Any]
    errors: List[str]

    def to_json(self) -> Dict[str, Any]:
        return {
            "success": self.success,
            "endpoint": self.endpoint,
            "errors": self.errors,
        }


def fetch_endpoint(url: str, timeout_sec: int = 20) -> requests.Response:
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
    }
    return requests.get(url, timeout=timeout_sec, headers=headers, allow_redirects=True)


def infer_method(url: str) -> str:
    # Probe endpoint is a read-only diagnostic and always uses GET.
    _ = url
    return "GET"


def is_store_like_record(value: Any) -> bool:
    if not isinstance(value, dict) or not value:
        return False
    keys = {str(k).lower() for k in value.keys()}
    if keys & STORE_KEYWORDS:
        return True
    key_blob = " ".join(keys)
    if any(token in key_blob for token in STORE_KEYWORDS):
        return True
    # Most store records have at least two of these fields.
    high_signal = {"name", "address", "city", "latitude", "longitude", "lat", "lng"}
    return len(keys & high_signal) >= 2


def iter_array_paths(value: Any, path: str = "", max_depth: int = 6) -> Iterable[Tuple[str, List[Any]]]:
    if max_depth < 0:
        return
    if isinstance(value, list):
        yield (path, value)
        for idx, item in enumerate(value[:4]):
            nested_path = f"{path}[{idx}]" if path else f"[{idx}]"
            yield from iter_array_paths(item, nested_path, max_depth - 1)
        return
    if isinstance(value, dict):
        for key, child in value.items():
            nested_path = f"{path}.{key}" if path else str(key)
            yield from iter_array_paths(child, nested_path, max_depth - 1)


def normalize_data_path(path: str) -> str:
    # For config data_path we want object traversal path only, not sample indices.
    return re.sub(r"\[\d+\]", "", path).strip(".")


def choose_best_store_array(payload: Any) -> Tuple[Optional[str], List[Dict[str, Any]]]:
    best_path: Optional[str] = None
    best_records: List[Dict[str, Any]] = []

    for path, arr in iter_array_paths(payload):
        dict_items = [item for item in arr if isinstance(item, dict)]
        if not dict_items:
            continue
        score = sum(1 for item in dict_items[:20] if is_store_like_record(item))
        if score == 0:
            continue
        if len(dict_items) > len(best_records):
            best_path = normalize_data_path(path)
            best_records = dict_items

    return best_path, best_records


def detect_field_mapping(records: Sequence[Dict[str, Any]]) -> Dict[str, str]:
    if not records:
        return {}
    sample_keys: List[str] = []
    for rec in records[:20]:
        sample_keys.extend([str(k) for k in rec.keys()])
    unique_keys = list(dict.fromkeys(sample_keys))
    lower_index = {k.lower(): k for k in unique_keys}

    mapping: Dict[str, str] = {}
    for canonical, synonyms in FIELD_SYNONYMS.items():
        for synonym in synonyms:
            if synonym in lower_index:
                mapping[canonical] = lower_index[synonym]
                break
    return mapping


def looks_paginated(payload: Any, endpoint_url: str) -> bool:
    if "page=" in endpoint_url.lower() or "offset=" in endpoint_url.lower():
        return True
    if not isinstance(payload, dict):
        return False
    keys = {str(k).lower() for k in payload.keys()}
    pagination_hints = {"page", "pages", "total_pages", "next", "has_next", "offset", "limit"}
    return len(keys & pagination_hints) > 0


def probe_json_payload(url: str, payload: Any) -> Dict[str, Any]:
    data_path, records = choose_best_store_array(payload)
    endpoint_type = "paginated" if looks_paginated(payload, url) else "json"
    return {
        "url": url,
        "type": endpoint_type,
        "confidence": 0.9 if records else 0.6,
        "verified": bool(records),
        "verified_store_count": len(records),
        "store_count": len(records),
        "data_path": data_path or "",
        "field_mapping": detect_field_mapping(records),
        "method": infer_method(url),
    }


def count_json_ld_store_blocks(html: str) -> int:
    blocks = re.findall(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    count = 0
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        try:
            data = json.loads(block)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            candidate_type = str(data.get("@type", "")).lower()
            if candidate_type in {"store", "localbusiness"}:
                count += 1
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    candidate_type = str(item.get("@type", "")).lower()
                    if candidate_type in {"store", "localbusiness"}:
                        count += 1
    return count


def probe_html_payload(url: str, html: str) -> Dict[str, Any]:
    store_count = count_json_ld_store_blocks(html)
    return {
        "url": url,
        "type": "html",
        "confidence": 0.7 if store_count else 0.45,
        "verified": store_count > 0,
        "verified_store_count": store_count,
        "store_count": store_count,
        "data_path": "",
        "field_mapping": {},
        "method": infer_method(url),
    }


def run_probe(url: str) -> ProbeResult:
    try:
        response = fetch_endpoint(url)
    except Exception as exc:  # pragma: no cover - network dependent
        return ProbeResult(
            success=False,
            endpoint={
                "url": url,
                "type": "unknown",
                "method": infer_method(url),
                "confidence": 0.0,
                "data_path": "",
                "field_mapping": {},
                "verified": False,
                "store_count": 0,
            },
            errors=[f"Request failed: {exc}"],
        )

    content_type = (response.headers.get("content-type") or "").lower()
    text = response.text or ""
    endpoint: Dict[str, Any]
    errors: List[str] = []

    try:
        if "application/json" in content_type or text.lstrip().startswith(("{", "[")):
            payload = response.json()
            endpoint = probe_json_payload(url, payload)
        else:
            endpoint = probe_html_payload(url, text)
    except Exception as exc:
        endpoint = {
            "url": url,
            "type": "unknown",
            "method": infer_method(url),
            "confidence": 0.2,
            "data_path": "",
            "field_mapping": {},
            "verified": False,
            "store_count": 0,
        }
        errors.append(f"Probe parse failed: {exc}")

    endpoint["status_code"] = response.status_code
    if response.status_code >= 400:
        errors.append(f"HTTP {response.status_code} response from endpoint")

    success = response.ok and endpoint.get("type") != "unknown"
    return ProbeResult(success=success, endpoint=endpoint, errors=errors)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe a manual endpoint URL")
    parser.add_argument("--url", required=True, help="Endpoint URL to probe")
    parser.add_argument("--output", help="Optional output path for JSON result")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    result = run_probe(args.url).to_json()
    json_text = json.dumps(result, indent=2)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as file_obj:
            file_obj.write(json_text)
    print(json_text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
