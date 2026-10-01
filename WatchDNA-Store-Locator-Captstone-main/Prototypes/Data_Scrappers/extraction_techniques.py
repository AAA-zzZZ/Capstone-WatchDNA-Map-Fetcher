#!/usr/bin/env python3
"""Dynamic extraction: JSON discovery from HTML, detail-page enrichment, technique comparison."""
import re
import json
import time
from typing import Dict, List, Any, Optional, Tuple
from urllib.parse import urljoin, urlparse

from pattern_detector import auto_generate_field_mapping as _infer_field_mapping  # single source of truth


def _collect_keys(obj: Any, prefix: str, out: set) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            full_key = f"{prefix}.{k}" if prefix else k
            out.add(full_key)
            _collect_keys(v, full_key, out)
    elif isinstance(obj, list) and obj and isinstance(obj[0], dict):
        _collect_keys(obj[0], prefix, out)


def _extract_store_from_obj(obj: Dict, mapping: Dict[str, str]) -> Dict[str, str]:
    result = {}
    for canonical, source_key in mapping.items():
        value = _get_nested(obj, source_key)
        if value is not None:
            if isinstance(value, list) and value:
                value = value[0] if isinstance(value[0], str) else str(value[0])
            elif isinstance(value, dict):
                value = value.get("display") or value.get("value") or str(value)
            result[canonical] = str(value).strip() if value else ""
        else:
            result[canonical] = ""
    return result


def _get_nested(obj: Dict, path: Any) -> Any:
    if not isinstance(path, str):
        return None
    keys = path.split(".")
    v = obj
    for k in keys:
        if isinstance(v, dict) and k in v:
            v = v[k]
        else:
            return None
    return v


def _find_store_arrays_in_json(data: Any) -> List[List[Dict]]:
    arrays = []
    if isinstance(data, list):
        if data and isinstance(data[0], dict):
            if _looks_like_store(data[0]):
                arrays.append(data)
        for item in data:
            arrays.extend(_find_store_arrays_in_json(item))
    elif isinstance(data, dict):
        for v in data.values():
            arrays.extend(_find_store_arrays_in_json(v))
    return arrays


def _looks_like_store(obj: Dict) -> bool:
    if not isinstance(obj, dict):
        return False
    keys_lower = [k.lower() for k in obj.keys()]
    has_coords = any(k in ["lat", "latitude", "y"] for k in keys_lower) and any(
        k in ["lng", "longitude", "x"] for k in keys_lower
    )
    has_name = any("name" in k or "title" in k for k in keys_lower)
    has_city = any("city" in k for k in keys_lower)
    return (has_coords or has_name) and (has_name or has_city)


def extract_stores_from_html_generic(html_content: str) -> List[Dict]:
    stores = []
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return stores

    soup = BeautifulSoup(html_content, "html.parser")

    for script in soup.find_all("script", type="application/json"):
        try:
            data = json.loads(script.string or "")
            arrays = _find_store_arrays_in_json(data)
            for arr in arrays:
                if len(arr) > len(stores):
                    mapping = _infer_field_mapping(arr[:5])
                    if mapping:
                        stores = [_extract_store_from_obj(o, mapping) for o in arr]
        except (json.JSONDecodeError, TypeError):
            continue

    if not stores:
        for script in soup.find_all("script"):
            if not script.string:
                continue
            for match in re.finditer(r'(?:var|let|const)\s+\w+\s*=\s*(\{[\s\S]*?\});', script.string):
                try:
                    data = json.loads(match.group(1))
                    arrays = _find_store_arrays_in_json(data)
                    for arr in arrays:
                        if len(arr) > len(stores):
                            mapping = _infer_field_mapping(arr[:5])
                            if mapping:
                                stores = [_extract_store_from_obj(o, mapping) for o in arr]
                except (json.JSONDecodeError, TypeError):
                    continue

    if not stores:
        pattern = r'\{"[^"]*"(?:name|title|storeName)[^"]*"[^}]*"(?:latitude|lat)"[^}]*"[^}]*"(?:longitude|lng)"[^}]*"[^}]*\}'
        for match in re.finditer(pattern, html_content):
            try:
                obj = json.loads(match.group(0))
                if _looks_like_store(obj):
                    mapping = _infer_field_mapping([obj])
                    if mapping:
                        stores.append(_extract_store_from_obj(obj, mapping))
            except (json.JSONDecodeError, TypeError):
                continue

    return stores


def _is_detail_url(url: str) -> bool:
    if not url or not isinstance(url, str):
        return False
    path = urlparse(url).path.lower()
    patterns = ["/store/", "/storedetails/", "/boutiques/", "/location/", "/dealer/", "/retailer/"]
    return any(p in path for p in patterns)


def _extract_from_detail_html(html: str) -> Dict[str, str]:
    result = {}
    for key, pattern in [
        ("Phone", r'"phone"\s*:\s*"([^"]+)"'),
        ("Email", r'"email"\s*:\s*"([^"]+)"'),
        ("Address Line 1", r'"streetAddress"\s*:\s*"([^"]+)"'),
    ]:
        m = re.search(pattern, html)
        if m:
            result[key] = m.group(1).strip()
    tel = re.search(r'tel:([+\d\s\-\(\)]+)', html)
    if tel:
        result.setdefault("Phone", tel.group(1).strip())
    mail = re.search(r'mailto:([^\s"\'<>]+)', html)
    if mail:
        result.setdefault("Email", mail.group(1).strip())
    return result


def enrich_stores_from_detail_pages(
    stores: List[Dict],
    fetch_fn,
    max_to_enrich: int = 50,
    delay_sec: float = 0.2,
) -> List[Dict]:
    enriched = []
    base_url = None
    for i, store in enumerate(stores):
        store = dict(store)
        url = store.get("Website", "") or store.get("websiteUrl", "") or store.get("url", "")
        if not url:
            enriched.append(store)
            continue
        if not url.startswith("http"):
            if base_url:
                url = urljoin(base_url, url)
            else:
                enriched.append(store)
                continue

        needs_enrichment = (
            not (store.get("Phone") or "").strip() or
            not (store.get("Email") or "").strip() or
            not (store.get("Address Line 1") or "").strip()
        )
        if not needs_enrichment or i >= max_to_enrich:
            enriched.append(store)
            continue

        if not _is_detail_url(url):
            enriched.append(store)
            continue

        try:
            html = fetch_fn(url)
            if html and isinstance(html, str):
                extra = _extract_from_detail_html(html)
                for k, v in extra.items():
                    if v and not (store.get(k) or "").strip():
                        store[k] = v
            time.sleep(delay_sec)
        except Exception:
            pass
        enriched.append(store)
    return enriched


def compute_extraction_metrics(stores: List[Dict]) -> Dict[str, Any]:
    if not stores:
        return {"total": 0}
    total = len(stores)
    critical_fields = ["Name", "Phone", "Email", "Address Line 1", "City", "Country", "Latitude", "Longitude"]
    counts = {f: sum(1 for s in stores if (s.get(f) or "").strip()) for f in critical_fields}
    pcts = {f"{f}_pct": round(100 * counts[f] / total, 1) for f in critical_fields}
    score = sum(counts[f] for f in critical_fields) / (total * len(critical_fields)) * 100
    return {
        "total": total,
        "counts": counts,
        "pcts": pcts,
        "completeness_score": round(score, 1),
    }


def run_extraction_with_techniques(
    raw_data: Any,
    extract_html_fn,
    fetch_fn=None,
    is_html: bool = False,
) -> Tuple[List[Dict], Dict[str, Any]]:
    all_results = []
    technique_metrics = {}

    if is_html and isinstance(raw_data, str):
        t1 = extract_html_fn(raw_data)
        m1 = compute_extraction_metrics(t1)
        all_results.append(("regex_pattern", t1, m1))
        technique_metrics["regex_pattern"] = m1

        t2 = extract_stores_from_html_generic(raw_data)
        m2 = compute_extraction_metrics(t2)
        all_results.append(("generic_json", t2, m2))
        technique_metrics["generic_json"] = m2

        best = max(all_results, key=lambda x: x[2].get("completeness_score", 0))
        best_stores = list(best[1])
        if fetch_fn and best_stores:
            t3 = enrich_stores_from_detail_pages(best_stores, fetch_fn)
            m3 = compute_extraction_metrics(t3)
            all_results.append(("detail_enrichment", t3, m3))
            technique_metrics["detail_enrichment"] = m3
            if m3.get("completeness_score", 0) > best[2].get("completeness_score", 0):
                best_stores = t3
        else:
            best_stores = best[1]
    else:
        best_stores = raw_data if isinstance(raw_data, list) else []
        technique_metrics["json_api"] = compute_extraction_metrics(best_stores)

    return best_stores, technique_metrics
