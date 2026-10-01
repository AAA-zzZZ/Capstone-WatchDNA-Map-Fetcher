#!/usr/bin/env python3
"""Detects store locator type (viewport, country filter, paginated, etc.) and expansion strategy."""

import re
import requests
from typing import Dict, List, Any, Optional
from urllib.parse import urlparse, parse_qs
import json


LOCATOR_TYPES = {
    "viewport": {
        "name": "Viewport/Bounds-Based API",
        "description": "Requires lat/lng bounds to return stores in that area",
        "indicators": ["viewport", "bounds", "bbox", "ne_lat", "sw_lat", "northEast", "southWest", "by_viewport"],
        "examples": ["Rolex retailers", "Some Shopify stores"],
        "strategy": "grid_scraping",
        "complexity": "high",
        "can_get_all": True
    },
    "country_filter": {
        "name": "Country/Region Filter",
        "description": "Filters by country code or region parameter",
        "indicators": ["country", "country_id", "countryCode", "country_code", "country-region", "country_region", "region", "regionCode"],
        "examples": ["Omega, Cartier, TAG Heuer"],
        "strategy": "iterate_countries",
        "complexity": "medium",
        "can_get_all": True
    },
    "radius_search": {
        "name": "Radius/Distance Search",
        "description": "Returns stores within radius of a coordinate",
        "indicators": ["radius", "distance", "within", "near"],
        "examples": ["Many custom implementations"],
        "strategy": "grid_points",
        "complexity": "high",
        "can_get_all": True
    },
    "paginated": {
        "name": "Paginated Full List",
        "description": "All stores available but split across pages",
        "indicators": ["page", "limit", "offset", "per_page", "skip", "take"],
        "examples": ["REST APIs", "WordPress stores"],
        "strategy": "pagination",
        "complexity": "low",
        "can_get_all": True
    },
    "single_call": {
        "name": "Single Endpoint (All Data)",
        "description": "Returns all stores in one API call",
        "indicators": [],
        "examples": ["Simple APIs", "Small chains"],
        "strategy": "direct_fetch",
        "complexity": "low",
        "can_get_all": True
    },
    "zip_search": {
        "name": "ZIP/Postal Code Search",
        "description": "Requires ZIP code to search",
        "indicators": ["zip", "zipcode", "postal", "postcode", "postalCode"],
        "examples": ["US-focused retailers"],
        "strategy": "zip_iteration",
        "complexity": "very_high",
        "can_get_all": False  # Impractical - too many ZIP codes
    },
    "city_search": {
        "name": "City/Location Text Search",
        "description": "Requires city name or address search",
        "indicators": ["city", "location", "address", "search", "q", "query"],
        "examples": ["Google-like search"],
        "strategy": "city_list",
        "complexity": "high",
        "can_get_all": True
    }
}


def detect_locator_type(url: str, sample_response: Any = None) -> Dict[str, Any]:
    result = {
        "url": url,
        "detected_type": "unknown",
        "confidence": 0.0,
        "url_params": {},
        "is_region_specific": False,
        "can_expand_to_world": False,
        "expansion_strategy": None,
        "complexity": "unknown",
        "matched_indicators": [],
        "estimated_calls_world": 1,
        "estimated_time_min": 0
    }
    parsed = urlparse(url)
    # keep_blank_values=True preserves params like input= (required by some APIs e.g. Yext vertical search)
    params = parse_qs(parsed.query, keep_blank_values=True)
    result["url_params"] = {k: v[0] if len(v) == 1 else v for k, v in params.items()}
    wp_ajax_sale_country = (
        "admin-ajax.php" in parsed.path.lower()
        and str(result["url_params"].get("action", "")).lower() == "sale_country"
    )
    scores = {}
    
    for type_key, type_info in LOCATOR_TYPES.items():
        score = 0.0
        matched = []
        for indicator in type_info["indicators"]:
            if any(indicator.lower() in k.lower() for k in params.keys()):
                score += 1.0
                matched.append(indicator)
            if indicator.lower() in parsed.path.lower():
                score += 0.5
                if indicator not in matched:
                    matched.append(indicator)
        
        if score > 0:
            scores[type_key] = {
                "score": score,
                "matched": matched,
                "info": type_info
            }
    
    if scores:
        best = max(scores.items(), key=lambda x: x[1]["score"])
        if "offset" in result["url_params"] and best[0] == "city_search" and "paginated" in scores:
            paginated_score = scores["paginated"]["score"]
            if paginated_score > 0:
                best = ("paginated", scores["paginated"])

        # Geo center + distance beats postal-only: many storefront APIs include empty
        # postalCode alongside lat/long + radius (e.g. SFCC Stores-FindStores).
        p = result["url_params"]
        has_geo_center = (
            ("lat" in p and ("long" in p or "lng" in p))
            or ("latitude" in p and ("longitude" in p or "lng" in p))
            or ("q" in p)
        )
        has_rad = any(
            k in p for k in ("radius", "r", "distance", "max_distance", "maxdistance")
        )
        if has_geo_center and has_rad and "radius_search" in scores:
            best = ("radius_search", scores["radius_search"])

        result["detected_type"] = best[0]
        result["confidence"] = min(best[1]["score"] / 2.0, 1.0)
        result["matched_indicators"] = best[1]["matched"]
        result["expansion_strategy"] = best[1]["info"]["strategy"]
        result["complexity"] = best[1]["info"]["complexity"]
        result["can_expand_to_world"] = best[1]["info"]["can_get_all"]
        if best[0] in ["viewport", "radius_search", "zip_search", "city_search", "country_filter"]:
            result["is_region_specific"] = True
    else:
        result["detected_type"] = "single_call"
        result["confidence"] = 0.7
        result["expansion_strategy"] = "direct_fetch"
        result["complexity"] = "low"
        result["can_expand_to_world"] = True
    if sample_response:
        response_analysis = analyze_response_clues(sample_response)
        result.update(response_analysis)
        if isinstance(sample_response, dict) and "pageToken" in sample_response:
            result["has_token_pagination"] = True
            result["pagination_type"] = "token"
        elif isinstance(sample_response, dict) and any("token" in str(k).lower() for k in sample_response.keys()):
            result["has_token_pagination"] = True
            result["pagination_type"] = "token"
        else:
            result["has_token_pagination"] = False
            result["pagination_type"] = "page_number"
    if wp_ajax_sale_country:
        result["detected_type"] = "single_call"
        result["confidence"] = max(float(result.get("confidence") or 0), 0.9)
        result["expansion_strategy"] = "direct_fetch"
        result["complexity"] = "low"
        result["can_expand_to_world"] = True
        result["is_region_specific"] = False
        result["matched_indicators"] = list(
            dict.fromkeys(
                (result.get("matched_indicators") or [])
                + ["wordpress_admin_ajax", "sale_country"]
            )
        )
    estimates = get_scraping_estimates(result["detected_type"])
    result["estimated_calls_world"] = estimates["calls"]
    result["estimated_time_min"] = estimates["time_min"]
    
    return result


def analyze_response_clues(response: Any) -> Dict[str, Any]:
    clues = {
        "appears_region_limited": False,
        "has_pagination": False,
        "returned_count": 0,
        "total_count": None,
        "likely_complete": False
    }
    if isinstance(response, list):
        data = response
    elif isinstance(response, dict):
        for key in ["data", "results", "items", "stores", "locations", "dealers", "retailers"]:
            if key in response and isinstance(response[key], list):
                data = response[key]
                break
        else:
            data = []
        if "total" in response or "total_count" in response or "count" in response:
            clues["has_pagination"] = True
            clues["total_count"] = response.get("total") or response.get("total_count") or response.get("count")
        
        if "page" in response or "next" in response or "has_more" in response:
            clues["has_pagination"] = True
    else:
        data = []
    
    clues["returned_count"] = len(data)
    if clues["returned_count"] > 0:
        if clues["returned_count"] in [10, 25, 50, 100, 250, 500]:
            clues["appears_region_limited"] = True
        if clues["total_count"] and clues["total_count"] != clues["returned_count"]:
            clues["appears_region_limited"] = True
        if clues["returned_count"] < 20:
            clues["appears_region_limited"] = True
        if clues["returned_count"] > 500:
            clues["likely_complete"] = True
    
    return clues


def get_scraping_estimates(locator_type: str, region: str = "world") -> Dict[str, Any]:
    estimates = {
        "viewport": {"calls": 720, "time_min": 6},
        "country_filter": {"calls": 195, "time_min": 2},
        "radius_search": {"calls": 2000, "time_min": 20},
        "paginated": {"calls": "varies", "time_min": "varies"},
        "single_call": {"calls": 1, "time_min": 0.1},
        "city_search": {"calls": 5000, "time_min": 50},
        "zip_search": {"calls": 42000, "time_min": 350}  # ~42K ZIP codes in US alone
    }
    
    return estimates.get(locator_type, {"calls": "unknown", "time_min": "unknown"})


def print_analysis(analysis: Dict[str, Any]):
    """Print analysis results."""
    print("=" * 80)
    print("🔍 STORE LOCATOR TYPE DETECTION & EXPANSION ANALYSIS")
    print("=" * 80)
    print()
    
    type_info = LOCATOR_TYPES.get(analysis["detected_type"], {})
    
    print(f"📍 URL: {analysis['url'][:80]}...")
    print()
    
    print(f"🏷️  Detected Type: {type_info.get('name', analysis['detected_type'])}")
    print(f"   {type_info.get('description', 'Unknown type')}")
    print()
    
    print(f"🎯 Confidence: {analysis['confidence']:.0%}")
    print(f"⚙️  Complexity: {analysis['complexity'].upper()}")
    print()
    
    if analysis.get("matched_indicators"):
        print(f"🔑 Matched Indicators: {', '.join(analysis['matched_indicators'])}")
        print()
    print("=" * 80)
    if analysis["is_region_specific"]:
        print("⚠️  REGION-SPECIFIC ENDPOINT DETECTED")
        print("=" * 80)
        print()
        print("   This endpoint only returns stores for a SPECIFIC REGION/AREA.")
        print("   A single API call will NOT give you all worldwide stores.")
        print()
        
        if analysis["can_expand_to_world"]:
            print(f"✅ CAN expand to worldwide data!")
            print(f"   Strategy: {analysis['expansion_strategy']}")
            print()
            
            print("📊 EXPANSION ESTIMATES (Worldwide):")
            print(f"   API calls needed: ~{analysis['estimated_calls_world']}")
            print(f"   Estimated time: ~{analysis['estimated_time_min']} minutes")
            print()
        else:
            print(f"❌ CANNOT practically expand to worldwide")
            print(f"   This type ({type_info.get('name')}) requires too many calls")
            print()
    else:
        print("✅ SINGLE ENDPOINT - ALL DATA")
        print("=" * 80)
        print()
        print("   This endpoint returns ALL stores in ONE API call.")
        print("   No expansion needed!")
        print()
    if "returned_count" in analysis:
        print("📦 SAMPLE RESPONSE ANALYSIS:")
        print(f"   Stores in sample: {analysis['returned_count']}")
        print(f"   Appears region-limited: {'YES' if analysis.get('appears_region_limited') else 'NO'}")
        
        if analysis.get("likely_complete"):
            print(f"   Likely complete dataset: ✅ YES")
        
        if analysis.get("has_pagination"):
            print(f"   Has pagination: YES")
            if analysis.get("total_count"):
                print(f"   Total count: {analysis['total_count']}")
        print()
    print("=" * 80)
    print("💡 RECOMMENDATIONS:")
    print("=" * 80)
    print()
    
    if not analysis["is_region_specific"]:
        print("   ✅ Use standard smart_scraper:")
        print(f'   python3 smart_scraper.py --url "{analysis["url"][:60]}..."')
    
    elif analysis["detected_type"] == "viewport":
        print("   ⚠️  Use viewport expansion scraper:")
        print(f"   python3 scrape_worldwide.py --url \"...\" --type viewport")
        print()
        print("   Configure a brand entry in brand_configs.json and run universal_scraper.py")
    
    elif analysis["detected_type"] == "country_filter":
        print("   ⚠️  Use country iteration:")
        print(f"   python3 scrape_worldwide.py --url \"...\" --type country")
    
    elif analysis["detected_type"] == "paginated":
        print("   ⚠️  Use pagination handler:")
        print(f"   python3 scrape_worldwide.py --url \"...\" --type paginated")
    
    else:
        print(f"   ⚠️  Need expansion strategy: {analysis['expansion_strategy']}")
        print(f"   This requires custom implementation")
    
    print()
    print("=" * 80)


def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Detect if store locator is region-specific and how to expand it',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Detect from URL only
  python3 locator_type_detector.py --url "https://retailers.rolex.com/..."
  
  # Detect AND fetch sample data
  python3 locator_type_detector.py --url "..." --fetch

This will tell you:
  1. Is this endpoint region-specific? (NYC only, or worldwide?)
  2. Can we expand it to get ALL stores worldwide?
  3. What strategy to use?
  4. How many API calls needed?
        """
    )
    
    parser.add_argument('--url', required=True, help='Store locator API URL')
    parser.add_argument('--fetch', action='store_true', help='Fetch sample data to analyze')
    
    args = parser.parse_args()
    
    sample_data = None
    
    if args.fetch:
        print(f"🌐 Fetching sample data...\n")
        try:
            response = requests.get(args.url, timeout=10, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            })
            response.raise_for_status()
            sample_data = response.json()
            print(f"✅ Sample data fetched\n")
        except Exception as e:
            print(f"⚠️  Could not fetch: {e}\n")
    
    # Run detection
    analysis = detect_locator_type(args.url, sample_data)
    
    # Print results
    print_analysis(analysis)
    
    # Save results
    with open("locator_analysis.json", "w") as f:
        json.dump(analysis, f, indent=2)
    
    print(f"💾 Full analysis saved to: locator_analysis.json\n")
    
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
