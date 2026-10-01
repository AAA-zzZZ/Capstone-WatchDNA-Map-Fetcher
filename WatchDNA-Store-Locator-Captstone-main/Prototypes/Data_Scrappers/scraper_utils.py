#!/usr/bin/env python3
"""Shared utilities for universal_scraper and viewport_grid."""

import re
from datetime import datetime
from typing import Any, Dict, Optional


def dict_get_ci(d: Dict[str, Any], key: str) -> Any:
    """
    Dict lookup: exact key first, then case-insensitive match (SFCC / .NET / GeoJSON).
    """
    if not isinstance(d, dict) or not key:
        return None
    if key in d:
        return d[key]
    kl = key.lower()
    for k, v in d.items():
        if isinstance(k, str) and k.lower() == kl:
            return v
    return None


def log_debug(message: str, level: str = "INFO") -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    prefix = {
        "INFO": "ℹ️ ",
        "SUCCESS": "✅",
        "ERROR": "❌",
        "WARN": "⚠️ ",
        "DEBUG": "🔍"
    }.get(level, "  ")
    print(f"[{timestamp}] {prefix} {message}", flush=True)


def resolve_partial_url(url_str: str, url_base: Optional[str]) -> str:
    """Reconstruct a relative store-detail URL using the brand's url_base.

    If url_str matches the pattern ``store/storedetails/<id>`` and url_base is
    provided, returns the full URL.  Otherwise returns url_str unchanged.
    """
    if not url_base:
        return url_str
    match = re.search(r'(?:^|/)store[/\\]storedetails[/\\]([^\s/]+)', url_str, re.IGNORECASE)
    if match:
        store_id = match.group(1).rstrip('/')
        return f"{url_base.rstrip('/')}/store/storedetails/{store_id}"
    return url_str
