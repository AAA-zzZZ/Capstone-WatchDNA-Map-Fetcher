#!/usr/bin/env python3
"""Viewport-based scraper for APIs that require lat/lng bounds (e.g. Rolex, Google Maps)."""

import requests
import time
import math
from typing import List, Dict, Any, Optional
from urllib.parse import urlencode

from scraper_utils import log_debug


def generate_world_grid(grid_size: int = 20) -> List[Dict[str, float]]:
    viewports = []
    min_lat, max_lat = -90, 90
    min_lng, max_lng = -180, 180
    lat = min_lat
    while lat < max_lat:
        lng = min_lng
        while lng < max_lng:
            viewport = {
                "sw_lat": lat,
                "sw_lng": lng,
                "ne_lat": min(lat + grid_size, max_lat),
                "ne_lng": min(lng + grid_size, max_lng)
            }
            viewports.append(viewport)
            lng += grid_size
        lat += grid_size
    
    return viewports


def generate_focused_grid(
    center_lat: float,
    center_lng: float,
    radius_degrees: float = 10,
    grid_size: int = 5
) -> List[Dict[str, float]]:
    viewports = []
    
    min_lat = max(-90, center_lat - radius_degrees)
    max_lat = min(90, center_lat + radius_degrees)
    min_lng = max(-180, center_lng - radius_degrees)
    max_lng = min(180, center_lng + radius_degrees)
    
    lat = min_lat
    while lat < max_lat:
        lng = min_lng
        while lng < max_lng:
            viewport = {
                "sw_lat": lat,
                "sw_lng": lng,
                "ne_lat": min(lat + grid_size, max_lat),
                "ne_lng": min(lng + grid_size, max_lng)
            }
            viewports.append(viewport)
            lng += grid_size
        lat += grid_size
    
    return viewports


def generate_country_grid(country_bounds: Dict[str, float], grid_size: int = 3) -> List[Dict[str, float]]:
    viewports = []
    
    lat = country_bounds["min_lat"]
    while lat < country_bounds["max_lat"]:
        lng = country_bounds["min_lng"]
        while lng < country_bounds["max_lng"]:
            viewport = {
                "sw_lat": lat,
                "sw_lng": lng,
                "ne_lat": min(lat + grid_size, country_bounds["max_lat"]),
                "ne_lng": min(lng + grid_size, country_bounds["max_lng"])
            }
            viewports.append(viewport)
            lng += grid_size
        lat += grid_size
    
    return viewports


def build_viewport_url(
    base_url: str,
    viewport: Dict[str, float],
    viewport_params: Dict[str, str],
    additional_params: Optional[Dict[str, str]] = None
) -> str:
    params = {}
    if "northEastLat" in viewport_params:
        params[viewport_params["northEastLat"]] = viewport["ne_lat"]
    if "northEastLng" in viewport_params:
        params[viewport_params["northEastLng"]] = viewport["ne_lng"]
    if "southWestLat" in viewport_params:
        params[viewport_params["southWestLat"]] = viewport["sw_lat"]
    if "southWestLng" in viewport_params:
        params[viewport_params["southWestLng"]] = viewport["sw_lng"]
    if additional_params:
        params.update(additional_params)
    if "?" in base_url:
        return f"{base_url}&{urlencode(params)}"
    else:
        return f"{base_url}?{urlencode(params)}"


_VIEWPORT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
}


def _merged_viewport_headers(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    h = dict(_VIEWPORT_HEADERS)
    if extra:
        h.update(extra)
    return h


def fetch_viewport_data(
    url: str,
    data_path: str = "",
    timeout: int = 15,
    retry_count: int = 3,
    request_headers: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    headers = _merged_viewport_headers(request_headers)
    for attempt in range(retry_count):
        try:
            resp = requests.get(url, timeout=timeout, headers=headers)
            resp.raise_for_status()
            if not resp.text or resp.text.strip() == '':
                return []
            try:
                data = resp.json()
            except ValueError:
                return []
            if data_path:
                keys = data_path.split('.')
                for key in keys:
                    if isinstance(data, dict):
                        data = data.get(key, [])
                    else:
                        return []
            if isinstance(data, list):
                return data
            else:
                return []
                
        except requests.exceptions.Timeout:
            if attempt < retry_count - 1:
                time.sleep(1 * (attempt + 1))
                continue
            else:
                return []
        except requests.exceptions.RequestException:
            return []
        except Exception:
            return []
    
    return []


def deduplicate_stores(stores: List[Dict[str, Any]], key_field: str = "id") -> List[Dict[str, Any]]:
    seen = set()
    unique_stores = []
    possible_keys = [key_field, "id", "storeId", "dealerId", "handle", "Handle"]
    
    for store in stores:
        # Find the first available ID field
        store_id = None
        for key in possible_keys:
            if key in store and store[key]:
                store_id = str(store[key])
                break
        if not store_id:
            name = store.get("name", store.get("nameTranslated", store.get("Name", "")))
            lat = store.get("lat", store.get("latitude", store.get("Latitude", "")))
            lng = store.get("lng", store.get("longitude", store.get("Longitude", "")))
            store_id = f"{name}_{lat}_{lng}"
        
        if store_id not in seen:
            seen.add(store_id)
            unique_stores.append(store)
    
    return unique_stores


def scrape_viewport_api(
    base_url: str,
    viewport_params: Dict[str, str],
    grid_type: str = "world",
    grid_size: int = 20,
    data_path: str = "",
    additional_params: Optional[Dict[str, str]] = None,
    delay_between_requests: float = 0.5,
    progress_interval: int = 50,
    focus_region: Optional[Dict[str, float]] = None,
    request_headers: Optional[Dict[str, str]] = None,
) -> List[Dict[str, Any]]:
    log_debug("Starting viewport API scraper", "INFO")
    log_debug(f"Grid type: {grid_type} | Grid size: {grid_size}° | Delay: {delay_between_requests}s", "DEBUG")
    if grid_type == "focused" and focus_region:
        log_debug(f"Generating focused grid: center=({focus_region['center_lat']}, {focus_region['center_lng']}) radius={focus_region.get('radius', 10)}°", "DEBUG")
        viewports = generate_focused_grid(
            focus_region["center_lat"],
            focus_region["center_lng"],
            focus_region.get("radius", 10),
            grid_size
        )
    elif grid_type == "country" and focus_region:
        log_debug(f"Generating country grid: bounds={focus_region}", "DEBUG")
        viewports = generate_country_grid(focus_region, grid_size)
    else:
        log_debug("Generating world grid (full global coverage)", "DEBUG")
        viewports = generate_world_grid(grid_size)
    
    log_debug(f"Grid generated: {len(viewports)} viewports", "SUCCESS")
    print(f"🌍 Generated {len(viewports)} viewports (grid_size={grid_size}°)")
    print(f"   Estimated time: ~{len(viewports) * delay_between_requests / 60:.1f} minutes")
    print(f"   Starting viewport scraping...")
    
    all_stores = []
    empty_viewports = 0
    start_time = time.time()
    update_interval = max(10, progress_interval // 5)

    for i, viewport in enumerate(viewports, 1):
        url = build_viewport_url(base_url, viewport, viewport_params, additional_params)
        stores = fetch_viewport_data(url, data_path, request_headers=request_headers)
        
        if stores:
            all_stores.extend(stores)
        else:
            empty_viewports += 1
        if i % update_interval == 0 or i == len(viewports):
            total_found = len(all_stores)
            percent_complete = (i / len(viewports)) * 100
            elapsed = time.time() - start_time
            estimated_total = (elapsed / i) * len(viewports) if i > 0 else 0
            remaining = estimated_total - elapsed
            
            print(f"   [{percent_complete:5.1f}%] {i}/{len(viewports)} viewports | {total_found} stores | {empty_viewports} empty | ETA: {remaining/60:.1f}min")
        if i < len(viewports):
            time.sleep(delay_between_requests)
    print(f"\n🔍 Deduplicating results...")
    log_debug(f"Starting deduplication | Input: {len(all_stores)} stores", "DEBUG")
    dedup_start = time.time()
    
    unique_stores = deduplicate_stores(all_stores)
    dedup_time = time.time() - dedup_start
    
    duplicates_removed = len(all_stores) - len(unique_stores)
    log_debug(f"Deduplication complete | Output: {len(unique_stores)} unique | Removed: {duplicates_removed} duplicates | Time: {dedup_time:.2f}s", "SUCCESS")
    print(f"✅ Found {len(unique_stores)} unique stores ({duplicates_removed} duplicates removed)")
    
    total_time = time.time() - start_time
    log_debug(f"Viewport scraping complete | Total time: {total_time:.2f}s ({total_time/60:.1f} min)", "SUCCESS")
    
    return unique_stores


REGION_PRESETS = {
    "north_america": {
        "center_lat": 45.0,
        "center_lng": -100.0,
        "radius": 35
    },
    "usa": {
        "min_lat": 24.5,
        "max_lat": 49.4,
        "min_lng": -125.0,
        "max_lng": -66.9
    },
    "europe": {
        "center_lat": 50.0,
        "center_lng": 10.0,
        "radius": 25
    },
    "uk": {
        "min_lat": 49.9,
        "max_lat": 60.9,
        "min_lng": -8.2,
        "max_lng": 1.8
    },
    "asia": {
        "center_lat": 34.0,
        "center_lng": 100.0,
        "radius": 40
    },
    "japan": {
        "min_lat": 24.0,
        "max_lat": 46.0,
        "min_lng": 123.0,
        "max_lng": 154.0
    },
    "china": {
        "min_lat": 18.0,
        "max_lat": 54.0,
        "min_lng": 73.0,
        "max_lng": 135.0
    },
    "australia": {
        "min_lat": -44.0,
        "max_lat": -10.0,
        "min_lng": 113.0,
        "max_lng": 154.0
    },
    "middle_east": {
        "center_lat": 29.0,
        "center_lng": 47.0,
        "radius": 20
    }
}


def get_region_preset(region_name: str) -> Optional[Dict[str, float]]:
    return REGION_PRESETS.get(region_name.lower())


if __name__ == "__main__":
    # Basic self-test with a synthetic viewport grid (no real HTTP calls)
    print("viewport_grid.py — self-test\n")

    cells = generate_world_grid(grid_size=40)
    print(f"World grid (40°): {len(cells)} cells")
    assert len(cells) > 0, "World grid must produce at least one cell"

    na = get_region_preset("north_america")
    assert na is not None, "north_america preset missing"
    focused = generate_focused_grid(na["center_lat"], na["center_lng"], radius_degrees=30, grid_size=10)
    print(f"Focused grid (30°, 10° cells): {len(focused)} cells")

    sample_stores = [
        {"id": "A", "name": "Store A", "lat": 40.7, "lng": -74.0},
        {"id": "A", "name": "Store A dup", "lat": 40.7, "lng": -74.0},
        {"id": "B", "name": "Store B", "lat": 51.5, "lng": -0.1},
    ]
    deduped = deduplicate_stores(sample_stores)
    assert len(deduped) == 2, f"Expected 2 unique stores, got {len(deduped)}"
    print(f"Deduplication: {len(sample_stores)} → {len(deduped)} stores")

    print("\n✅ All self-tests passed")

