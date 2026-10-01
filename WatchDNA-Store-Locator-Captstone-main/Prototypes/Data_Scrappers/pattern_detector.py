#!/usr/bin/env python3
"""Auto-detects store locator data structure and generates field mappings."""

import re
import json
from typing import Dict, List, Any, Optional, Tuple


FIELD_PATTERNS = {
    "Handle": [
        "id", "store_id", "location_id", "dealer_id", "shop_id",
        "dealerId", "retailer_id", "handle", "slug"
    ],
    "Name": [
        "name", "store_name", "location_name", "title", "dealer_name",
        "shop_name", "nameTranslated", "dealerName", "storeName",
        "business_name", "retailer_name"
    ],
    "Address Line 1": [
        "address", "address1", "street", "street_address", "streetAddress",
        "address_line_1", "addressLine1", "addr1", "street1"
    ],
    "Address Line 2": [
        "address2", "address_line_2", "addressLine2", "addr2", "street2",
        "suite", "unit", "apt", "floor"
    ],
    "City": [
        "city", "town", "locality", "cityName", "city_name"
    ],
    "State/Province/Region": [
        "state", "province", "region", "state_province", "regionName",
        "stateName", "state_name", "province_name"
    ],
    "Country": [
        "country", "country_code", "countryName", "country_name", "nation"
    ],
    "Postal/ZIP Code": [
        "zip", "zipcode", "postal", "postal_code", "postalCode",
        "postcode", "zip_code"
    ],
    "Phone": [
        "phone", "telephone", "tel", "phone_number", "phoneNumber",
        "phone1", "contact_phone", "mobile"
    ],
    "Email": [
        "email", "contact_email", "e_mail", "mail"
    ],
    "Website": [
        "website", "url", "web", "site_url", "homepage", "link",
        "dealerSiteUrl", "inventoryExternalUrl", "website_url"
    ],
    "Latitude": [
        "lat", "latitude", "geo_lat", "geoLat", "coord_lat"
    ],
    "Longitude": [
        "lng", "lon", "long", "longitude", "geo_lng", "geoLng", "coord_lng"
    ],
    "Image URL": [
        "image", "img", "photo", "picture", "imageUrl", "image_url",
        "logo", "logo_url", "thumbnail"
    ],
    "Monday": ["monday", "mon", "Monday"],
    "Tuesday": ["tuesday", "tue", "Tuesday"],
    "Wednesday": ["wednesday", "wed", "Wednesday"],
    "Thursday": ["thursday", "thu", "Thursday"],
    "Friday": ["friday", "fri", "Friday"],
    "Saturday": ["saturday", "sat", "Saturday"],
    "Sunday": ["sunday", "sun", "Sunday"]
}

DATA_STRUCTURE_PATTERNS = {
    "flat_array": "Array of flat objects at root",
    "nested_array": "Array nested within response object",
    "nested_locations": "Nested under 'locations', 'stores', or similar key",
    "paginated": "Paginated response with data + meta",
    "viewport_based": "Requires viewport/bounds parameters",
    "geojson": "GeoJSON format with features array",
    "html_cards": "HTML with repeating card/item elements",
}


def detect_data_structure(data: Any, url: str = "") -> Dict[str, Any]:
    result = {
        "type": "unknown",
        "data_path": "",
        "is_array": False,
        "is_nested": False,
        "is_paginated": False,
        "is_viewport_based": False,
        "is_geojson": False,
        "confidence": 0.0
    }
    viewport_keywords = ["viewport", "bounds", "bbox", "ne_lat", "sw_lat", "northEast", "southWest"]
    if url and any(kw in url.lower() for kw in viewport_keywords):
        result["is_viewport_based"] = True
        result["confidence"] += 0.3
    if isinstance(data, list):
        result["is_array"] = True
        result["type"] = "flat_array"
        result["data_path"] = ""
        result["confidence"] = 0.9
        return result
    
    if isinstance(data, dict):
        if "type" in data and "features" in data and data.get("type") == "FeatureCollection":
            result["type"] = "geojson"
            result["is_geojson"] = True
            result["data_path"] = "features"
            result["confidence"] = 1.0
            return result
        pagination_keys = ["page", "pages", "total", "count", "next", "prev", "pagination"]
        if any(key in data for key in pagination_keys):
            result["is_paginated"] = True
            result["confidence"] += 0.3
        common_data_keys = [
            "data", "results", "items", "stores", "locations", "retailers",
            "dealers", "shops", "establishments", "places", "markers"
        ]
        
        for key in common_data_keys:
            if key in data and isinstance(data[key], list):
                result["type"] = "nested_array"
                result["is_nested"] = True
                result["is_array"] = True
                result["data_path"] = key
                result["confidence"] = 0.9
                return result
        
        # Check for nested objects (like Shopify structure)
        for key, value in data.items():
            if isinstance(value, dict) and any(k in value for k in common_data_keys):
                for nested_key in common_data_keys:
                    if nested_key in value and isinstance(value[nested_key], list):
                        result["type"] = "nested_array"
                        result["is_nested"] = True
                        result["data_path"] = f"{key}.{nested_key}"
                        result["confidence"] = 0.8
                        return result
    
    return result


def detect_coordinate_format(data: Any) -> str:
    """
    Detect how coordinates are stored
    
    Returns:
        "lat_lng", "latitude_longitude", "geo_lat_lng", "coordinates", or "unknown"
    """
    if isinstance(data, list) and len(data) > 0:
        sample = data[0]
    elif isinstance(data, dict):
        sample = data
    else:
        return "unknown"
    
    # Check various coordinate formats
    if "lat" in sample and "lng" in sample:
        return "lat_lng"
    if "latitude" in sample and "longitude" in sample:
        return "latitude_longitude"
    if "geoLat" in sample and "geoLng" in sample:
        return "geo_lat_lng"
    if "coordinates" in sample:
        return "coordinates_array"
    if "location" in sample and isinstance(sample["location"], dict):
        return "nested_location"
    
    return "unknown"


def detect_hours_format(sample_data: Dict) -> Dict[str, Any]:
    """
    Detect how store hours are stored
    
    Returns:
        Dict with format info: type, keys, needs_parsing
    """
    result = {
        "type": "unknown",
        "keys": [],
        "needs_parsing": False,
        "format": None
    }
    
    # Check for day-based keys (Monday, Tuesday, etc.)
    day_keys = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    found_days = [day for day in day_keys if day in [k.lower() for k in sample_data.keys()]]
    
    if len(found_days) >= 5:
        result["type"] = "day_keys"
        result["keys"] = found_days
        return result
    
    # Check for hours array (like Rolex)
    hours_array_keys = ["hours", "hoursDetails", "hoursTranslatedDetails", "openingHours", "businessHours"]
    for key in hours_array_keys:
        if key in sample_data and isinstance(sample_data[key], list):
            result["type"] = "hours_array"
            result["keys"] = [key]
            result["needs_parsing"] = True
            result["format"] = "array"
            return result
    
    # Check for single hours string
    hours_string_keys = ["hours", "opening_hours", "business_hours", "hours_of_operation"]
    for key in hours_string_keys:
        if key in sample_data and isinstance(sample_data[key], str):
            result["type"] = "hours_string"
            result["keys"] = [key]
            result["needs_parsing"] = True
            result["format"] = "string"
            return result
    
    return result


def auto_generate_field_mapping(sample_data: Any) -> Dict[str, Any]:
    """
    Automatically generate field mapping based on detected patterns
    
    Args:
        sample_data: Sample data record (single store/location)
    
    Returns:
        Dict mapping canonical fields to source fields
    """
    if isinstance(sample_data, list):
        if len(sample_data) == 0:
            return {}
        sample_data = sample_data[0]
    
    if not isinstance(sample_data, dict):
        return {}
    
    mapping = {}
    
    # Get all keys from sample (case-insensitive matching)
    sample_keys = list(sample_data.keys())
    sample_keys_lower = {k.lower(): k for k in sample_keys}
    
    # Match each canonical field to source fields
    for canonical_field, patterns in FIELD_PATTERNS.items():
        matches = []
        
        for pattern in patterns:
            pattern_lower = pattern.lower()
            
            # Exact match (case-insensitive)
            if pattern_lower in sample_keys_lower:
                matches.append(sample_keys_lower[pattern_lower])
            
            # Partial match (contains)
            else:
                for key_lower, key_orig in sample_keys_lower.items():
                    if pattern_lower in key_lower or key_lower in pattern_lower:
                        if key_orig not in matches:
                            matches.append(key_orig)
        
        # Assign the best match(es)
        if len(matches) == 1:
            mapping[canonical_field] = matches[0]
        elif len(matches) > 1:
            # Prefer exact matches, then shorter names — always pick one winner
            matches.sort(key=lambda x: (x.lower() not in [p.lower() for p in patterns], len(x)))
            mapping[canonical_field] = matches[0]
    
    # Always set Status to TRUE for scraped data
    mapping["Status"] = "TRUE"
    
    return mapping


def score_field_mapping(mapping: Dict[str, Any]) -> Dict[str, Any]:
    """
    Score the quality of a field mapping
    
    Returns:
        Dict with scores and recommendations
    """
    required_fields = ["Name", "Address Line 1", "City"]
    recommended_fields = ["Latitude", "Longitude", "Phone", "Country", "State/Province/Region"]
    
    score = {
        "total_score": 0.0,
        "has_required": [],
        "missing_required": [],
        "has_recommended": [],
        "missing_recommended": [],
        "confidence": "unknown"
    }
    
    # Check required fields
    for field in required_fields:
        if field in mapping and mapping[field]:
            score["has_required"].append(field)
            score["total_score"] += 1.0
        else:
            score["missing_required"].append(field)
    
    # Check recommended fields
    for field in recommended_fields:
        if field in mapping and mapping[field]:
            score["has_recommended"].append(field)
            score["total_score"] += 0.5
        else:
            score["missing_recommended"].append(field)
    
    # Calculate confidence
    max_score = len(required_fields) + len(recommended_fields) * 0.5
    confidence_pct = (score["total_score"] / max_score) * 100
    
    if confidence_pct >= 80:
        score["confidence"] = "high"
    elif confidence_pct >= 60:
        score["confidence"] = "medium"
    else:
        score["confidence"] = "low"
    
    score["confidence_percentage"] = confidence_pct
    
    return score


def extract_sample_data(data: Any, data_path: str = "", limit: int = 3) -> List[Dict]:
    """
    Extract sample records from data structure
    
    Args:
        data: Raw data
        data_path: Path to array (e.g., "data.stores")
        limit: Max number of samples to extract
    
    Returns:
        List of sample records
    """
    # Navigate to the data using data_path
    current = data
    if data_path:
        for key in data_path.split('.'):
            if isinstance(current, dict) and key in current:
                current = current[key]
            else:
                return []
    
    # Extract samples
    if isinstance(current, list):
        return current[:limit]
    elif isinstance(current, dict):
        return [current]
    
    return []


def detect_data_pattern(url: str, sample_response: Any) -> Dict[str, Any]:
    """
    Main function to detect complete data pattern.

    Args:
        url: API endpoint or page URL
        sample_response: Sample response data (dict, list, or HTML string)

    Returns:
        Complete pattern analysis with structure, fields, and recommendations
    """
    pattern = {
        "url": url,
        "structure": {},
        "coordinate_format": "unknown",
        "hours_format": {},
        "field_mapping": {},
        "mapping_score": {},
        "sample_data": [],
        "recommendations": []
    }
    
    # Detect structure
    pattern["structure"] = detect_data_structure(sample_response, url)
    
    # Extract sample data
    samples = extract_sample_data(sample_response, pattern["structure"]["data_path"])
    pattern["sample_data"] = samples
    
    if not samples:
        pattern["recommendations"].append("❌ Could not extract sample data - check data_path")
        # Initialize mapping_score with default values to prevent KeyError
        pattern["mapping_score"] = {
            "total_score": 0.0,
            "has_required": [],
            "missing_required": ["Name", "Address Line 1", "City"],
            "has_recommended": [],
            "missing_recommended": [],
            "confidence": "unknown",
            "confidence_percentage": 0.0
        }
        return pattern
    
    # Detect coordinate format
    pattern["coordinate_format"] = detect_coordinate_format(samples)
    
    # Detect hours format
    pattern["hours_format"] = detect_hours_format(samples[0])
    
    # Auto-generate field mapping
    pattern["field_mapping"] = auto_generate_field_mapping(samples[0])
    
    # Score the mapping
    pattern["mapping_score"] = score_field_mapping(pattern["field_mapping"])
    
    # Generate recommendations
    if pattern["mapping_score"]["confidence"] == "high":
        pattern["recommendations"].append("✅ High confidence mapping - ready to scrape")
    elif pattern["mapping_score"]["confidence"] == "medium":
        pattern["recommendations"].append("⚠️  Medium confidence - review mapping before scraping")
    else:
        pattern["recommendations"].append("❌ Low confidence - manual review required")
    
    if pattern["mapping_score"]["missing_required"]:
        pattern["recommendations"].append(
            f"⚠️  Missing required fields: {', '.join(pattern['mapping_score']['missing_required'])}"
        )
    
    if pattern["coordinate_format"] == "unknown":
        pattern["recommendations"].append("⚠️  Could not detect coordinate format")
    
    return pattern


def print_pattern_analysis(pattern: Dict[str, Any], verbose: bool = True):
    """Pretty print pattern analysis results"""
    print("=" * 80)
    print("PATTERN DETECTION RESULTS")
    print("=" * 80)
    print()
    
    print(f"📍 URL: {pattern['url']}")
    print()
    
    # Structure
    print("🏗️  DATA STRUCTURE:")
    structure = pattern["structure"]
    print(f"   Type: {structure['type']}")
    print(f"   Data path: '{structure['data_path']}' (empty = root array)")
    print(f"   Is array: {structure['is_array']}")
    print(f"   Is nested: {structure['is_nested']}")
    print(f"   Is viewport-based: {structure['is_viewport_based']}")
    print(f"   Confidence: {structure['confidence']:.0%}")
    print()
    
    # Field Mapping
    print("🗺️  FIELD MAPPING:")
    score = pattern["mapping_score"]
    print(f"   Confidence: {score['confidence'].upper()} ({score['confidence_percentage']:.1f}%)")
    print(f"   Required fields found: {len(score['has_required'])}/{len(score['has_required']) + len(score['missing_required'])}")
    print()
    
    if verbose:
        print("   Detected mappings:")
        for canonical, source in pattern["field_mapping"].items():
            if source and source != "TRUE":
                source_str = source if isinstance(source, str) else str(source)
                print(f"      {canonical:<30} → {source_str}")
        print()
    
    # Coordinates
    print(f"📍 COORDINATE FORMAT: {pattern['coordinate_format']}")
    print()
    
    # Hours
    hours = pattern["hours_format"]
    print(f"🕒 HOURS FORMAT: {hours['type']}")
    if hours['keys']:
        print(f"   Keys: {', '.join(hours['keys'])}")
        print(f"   Needs parsing: {hours['needs_parsing']}")
    print()
    
    # Recommendations
    print("💡 RECOMMENDATIONS:")
    for rec in pattern["recommendations"]:
        print(f"   {rec}")
    print()
    
    print("=" * 80)


def main():
    import argparse
    import requests
    
    parser = argparse.ArgumentParser(
        description='Detect store locator data patterns',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Detect pattern from API
  python3 pattern_detector.py --url "https://api.example.com/stores"
  
  # Detect pattern from JSON file
  python3 pattern_detector.py --file sample_data.json
        """
    )
    
    parser.add_argument('--url', help='API endpoint URL')
    parser.add_argument('--file', help='JSON file with sample data')
    parser.add_argument('--verbose', action='store_true', help='Show detailed mapping')
    
    args = parser.parse_args()
    
    # Load data
    if args.url:
        print(f"🌐 Fetching data from: {args.url}\n")
        try:
            response = requests.get(args.url, timeout=10)
            response.raise_for_status()
            data = response.json()
            url = args.url
        except Exception as e:
            print(f"❌ Error fetching data: {e}")
            return 1
    
    elif args.file:
        print(f"📁 Loading data from: {args.file}\n")
        try:
            with open(args.file, 'r') as f:
                data = json.load(f)
            url = args.file
        except Exception as e:
            print(f"❌ Error loading file: {e}")
            return 1
    
    else:
        print("❌ Please provide --url or --file")
        return 1
    
    pattern = detect_data_pattern(url, data)
    print_pattern_analysis(pattern, verbose=args.verbose)
    if pattern["mapping_score"]["confidence"] in ["high", "medium"]:
        output_file = "detected_mapping.json"
        with open(output_file, 'w') as f:
            json.dump({
                "field_mapping": pattern["field_mapping"],
                "data_path": pattern["structure"]["data_path"],
                "structure": pattern["structure"]
            }, f, indent=2)
        print(f"\n💾 Mapping saved to: {output_file}")
    
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())

