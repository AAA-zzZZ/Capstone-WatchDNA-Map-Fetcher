#!/usr/bin/env python3
"""Detects endpoint patterns and suggests brand configuration from brand_configs.json."""

import json
import re
from typing import Dict, List, Optional, Any
from urllib.parse import urlparse, parse_qs


class PatternDetector:
    FIELD_PATTERNS = {
        "Name": ["name", "nameTranslated", "shortName", "establishment_name", "title"],
        "Address Line 1": ["streetAddress", "shortAddress", "address", "address1", "address.line1", "address.street"],
        "Address Line 2": ["address2", "address.line2", "address.street2"],
        "City": ["cityName", "city", "address.city"],
        "State/Province/Region": ["regionName", "state", "province", "region", "stateCode", "state_code", "address.region", "address.state"],
        "Country": ["countryName", "country", "countryCode", "country_code", "address.countryCode", "address.country"],
        "Postal/ZIP Code": ["postalCode", "zipCode", "zip", "postal", "postcode", "address.postalCode"],
        "Phone": ["mainPhone.display", "mainPhone.number", "phone1", "phone", "phoneNumber", "mainPhone", "telephone"],
        "Email": ["c_baaEmail", "emails.0", "emails", "email", "contact_email"],
        "Website": ["urlRolexV7", "website", "url", "permalink"],
        "Latitude": ["lat", "latitude"],  # Dynamic detection handles nested paths (e.g., .lat, .latitude suffixes)
        "Longitude": ["lng", "longitude", "lon", "long"],  # Dynamic detection handles nested paths (e.g., .lng, .longitude suffixes)
        "Handle": ["id", "ID", "meta.id", "profile.meta.id"]
    }
    
    def __init__(self):
        pass

    def detect_and_suggest(self, endpoints: List[Dict], html_analysis: Optional[Dict], base_url: str) -> Optional[Dict]:
        if not endpoints:
            # If no endpoints found, check HTML
            if html_analysis:
                return self._suggest_html_config(html_analysis, base_url)
            return None
        
        # Get best endpoint (highest confidence)
        best_endpoint = endpoints[0] if endpoints else None
        if not best_endpoint:
            return None
        
        endpoint_type = best_endpoint.get('type', 'json')
        endpoint_url = best_endpoint.get('url', '')
        
        # JSON-based endpoint types (paginated, viewport, radius, etc. are all JSON APIs)
        json_endpoint_types = ['json', 'paginated', 'viewport', 'radius', 'country_filter']
        
        if endpoint_type in json_endpoint_types:
            return self._suggest_json_config(best_endpoint, base_url)
        elif endpoint_type == 'html':
            return self._suggest_html_config(html_analysis or {}, base_url)
        else:
            return self._suggest_generic_config(best_endpoint, base_url)
    
    def _suggest_json_config(self, endpoint: Dict, base_url: str) -> Dict:
        """Suggest JSON API configuration"""
        # Prefer optimized URL (from radius optimization), then base URL, then original URL
        url = endpoint.get('optimized_url') or endpoint.get('url', '')
        
        if endpoint.get('optimized_url'):
            print(f"  💡 Using optimized radius endpoint")
            if endpoint.get('original_url'):
                print(f"     Original: {endpoint.get('original_url', '')[:100]}")
            print(f"     Optimized: {url[:100]}")
            if endpoint.get('optimization_info'):
                opt_info = endpoint.get('optimization_info', {})
                radius_info = f"radius={opt_info.get('radius_used', 'N/A')}"
                center_info = opt_info.get('center_used', '')
                if center_info:
                    radius_info += f", {center_info}"
                print(f"     {radius_info}, Stores: {opt_info.get('best_store_count', 0)}")
                print(f"     Tested {opt_info.get('tested_variants', 0)} variants to find best configuration")
        elif endpoint.get('is_base_url') and endpoint.get('original_url'):
            # Prefer the base URL that was found
            url = endpoint.get('url', '')
            print(f"  💡 Using base URL (removed location-specific parameters)")
            print(f"     Original: {endpoint.get('original_url', '')[:100]}")
            print(f"     Base:     {url[:100]}")
        
        params = endpoint.get('params', {})
        # Prefer verified_type from verifier only when it's a real classification.
        # 'unknown' means verification failed (e.g. 403 block) - fall back to network_analyzer type.
        _VALID_TYPES = {'viewport', 'radius', 'country_filter', 'paginated', 'single_call', 'json', 'html'}
        verified_type = endpoint.get('verified_type')
        endpoint_type = (verified_type if verified_type in _VALID_TYPES else None) or endpoint.get('type', 'json')
        
        # For radius-based endpoints only - do NOT add radius/center for country_filter
        # Country-filter endpoints (e.g. Bulgari country-region=US) need country iteration, not radius
        if endpoint_type == 'radius':
            url = self._build_optimized_radius_url(url, endpoint)
            print(f"  💡 Built optimized radius URL with center point and large radius")
        
        # Detect endpoint pattern
        if endpoint_type == 'viewport':
            description = "Viewport-based API - Requires lat/lng bounds. Universal scraper will expand using grid."
        elif endpoint_type == 'radius':
            description = "Radius-based API - Requires center point and radius. Universal scraper will use multi-point expansion."
        elif endpoint_type == 'country_filter':
            description = "Country-filter API - Filters by country. Universal scraper will iterate through countries."
        elif endpoint_type == 'paginated':
            description = "Paginated API - Returns stores in pages. Universal scraper will follow pagination."
        else:
            description = "JSON API - Single call returns all stores"
        
        # Prefer verified endpoint data if available (from endpoint_verifier)
        field_mapping = {}
        data_path = ""
        
        # Check if endpoint was verified and has sample stores
        if endpoint.get('verified') and endpoint.get('sample_stores'):
            sample_stores = endpoint.get('sample_stores', [])
            if sample_stores and len(sample_stores) > 0:
                # Use verified data_path if available, otherwise try to detect it
                data_path = endpoint.get('data_path', '')
                if not data_path:
                    # If verifier didn't set data_path, try to detect it from the endpoint
                    try:
                        import requests
                        response = requests.get(url, timeout=5, headers={
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Accept': 'application/json'
                        })
                        if response.status_code == 200:
                            data = response.json()
                            data_path = self._detect_data_path(data)
                    except Exception as e:
                        print(f"  ⚠️  Warning: Could not detect data_path: {e}")
                
                # Always re-detect field mappings from verified sample stores for accuracy
                # The verified field_mapping might be incomplete or incorrect
                try:
                    detected_mapping = self._detect_field_mapping_robust(sample_stores)
                    if detected_mapping and len(detected_mapping) > 0:
                        field_mapping = detected_mapping
                        print(f"  ✓ Detected {len(field_mapping)} field mappings from verified stores")
                        
                        # If we got a verified field_mapping and our detection found fewer fields, merge them
                        # BUT: Only add fields that are missing - detected mappings take precedence
                        if endpoint.get('field_mapping') and isinstance(endpoint.get('field_mapping'), dict):
                            verified_mapping = endpoint.get('field_mapping')
                            # Merge verified mapping into detected mapping (detected takes precedence)
                            for key, value in verified_mapping.items():
                                if key not in field_mapping:
                                    field_mapping[key] = value
                    else:
                        print(f"  ⚠️  Warning: Field mapping detection returned empty dict - will try to fetch from endpoint")
                        # Don't use verified_mapping if detection failed - it might have wrong format (arrays)
                except Exception as e:
                    print(f"  ⚠️  Warning: Field mapping detection failed: {e}")
                    import traceback
                    traceback.print_exc()
                    # Don't use verified_mapping if detection failed
        
        # If no verified data, try to fetch and analyze (use limit=15 to avoid 1600+ store downloads)
        if not field_mapping:
            try:
                import requests
                from urllib.parse import urlparse, parse_qs
                fetch_url = url
                parsed = urlparse(url)
                params = parse_qs(parsed.query, keep_blank_values=True)
                param_keys = [k.lower() for k in params.keys()]
                if not any(p in param_keys for p in ['limit', 'per', 'per_page', 'count', 'take', 'page_size']):
                    sep = '&' if parsed.query else '?'
                    fetch_url = f"{url}{sep}limit=15"
                response = requests.get(fetch_url, timeout=10, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                })
                
                if response.status_code == 200:
                    data = response.json()
                    
                    # Detect data path
                    if not data_path:
                        data_path = self._detect_data_path(data)
                    
                    # Detect field mappings
                    stores = self._extract_stores(data, data_path)
                    if stores and len(stores) > 0:
                        field_mapping = self._detect_field_mapping_robust(stores[:3])  # Use first 3 for robustness
        
            except Exception as e:
                pass  # Use default mappings
        
        # Build configuration
        # Ensure data_path is set (prefer verified, then detected, then from endpoint)
        final_data_path = data_path or endpoint.get('data_path', '')
        if not final_data_path and endpoint.get('verified'):
            # If verified but no data_path, try to detect from endpoint structure
            try:
                import requests
                from urllib.parse import urlparse, parse_qs
                fetch_url = url
                parsed = urlparse(url)
                params = parse_qs(parsed.query, keep_blank_values=True)
                param_keys = [k.lower() for k in params.keys()]
                if not any(p in param_keys for p in ['limit', 'per', 'per_page', 'count', 'take', 'page_size']):
                    sep = '&' if parsed.query else '?'
                    fetch_url = f"{url}{sep}limit=15"
                response = requests.get(fetch_url, timeout=5, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json'
                })
                if response.status_code == 200:
                    data = response.json()
                    final_data_path = self._detect_data_path(data)
            except:
                pass
        
        # Use detected field_mapping if it has any keys, otherwise use defaults
        final_field_mapping = field_mapping if field_mapping and len(field_mapping) > 0 else self._get_default_field_mapping()
        
        _JSON_LIKE_TYPES = {'json', 'paginated', 'viewport', 'radius', 'country_filter', 'single_call'}
        config = {
            "type": endpoint_type if endpoint_type in _JSON_LIKE_TYPES else "json",
            "url": url,
            "description": description,
            "method": "GET",
            "field_mapping": final_field_mapping
        }
        
        # Only include data_path if it's not empty
        if final_data_path:
            config["data_path"] = final_data_path
        
        # Add type-specific notes
        if endpoint_type == 'viewport':
            config["description"] += " - Universal scraper handles viewport expansion automatically"
            config["_note"] = "This endpoint requires viewport coordinates. The universal scraper will automatically expand using a grid to get all stores worldwide."
        elif endpoint_type == 'radius':
            # Build a detailed description for radius-based endpoints
            url_params = self._parse_url_params(url)
            radius_val = (
                url_params.get('max_distance')
                or url_params.get('maxdistance')
                or url_params.get('r')
                or url_params.get('radius')
                or url_params.get('distance')
                or '2000'
            )
            
            # Extract center point info (SFCC uses latitude & longitude query params)
            lat = url_params.get('latitude') or url_params.get('lat')
            lng = (
                url_params.get('longitude')
                or url_params.get('lng')
                or url_params.get('long')
            )
            if lat and lng:
                center_coords = f'{lat},{lng}'
            else:
                center_coords = url_params.get('q') or url_params.get('center') or '48.8566,2.3522'
            if center_coords == '48.8566,2.3522':
                center_point = 'Paris center point'
            elif ',' in str(center_coords):
                center_point = f'center point ({center_coords})'
            else:
                center_point = 'center point'
            
            # Check for pagination (SFCC often uses start=0&count=100)
            has_pagination = any(
                p in url_params for p in ['offset', 'per', 'per_page', 'limit', 'page', 'start', 'count']
            )
            pagination_info = ""
            if has_pagination:
                per_val = (
                    url_params.get('count')
                    or url_params.get('per')
                    or url_params.get('per_page')
                    or url_params.get('limit')
                    or '50'
                )
                if 'start' in url_params:
                    pagination_info = f" with start/count pagination (~{per_val} stores per request)"
                else:
                    pagination_info = f" with offset pagination, returns {per_val} stores per page"
            
            dist_unit = (url_params.get('distance_unit') or 'mi').lower()
            radius_desc = f"max_distance={radius_val} {dist_unit}" if url_params.get('max_distance') else f"radius={radius_val}km"
            config["description"] = (
                f"Radius-based search API{pagination_info}. Uses {radius_desc} from {center_point}. "
                "Scraper should iterate start (or offset) for each map center and use multiple centers worldwide for full coverage ✅"
            )
            config["_note"] = (
                "Radius / bounding search: paginate with start+count or offset+limit per center; "
                "repeat for multiple lat/lng centers to cover the globe (API caps results per request)."
            )
        elif endpoint_type == 'country_filter':
            # Ensure URL has country param for iteration - use base URL with example country
            # Scraper will replace country-region=US with IT, FR, etc. for worldwide coverage
            config["description"] = "Country-filter API - Change country param (e.g. country-region=US to IT, FR) for worldwide stores. Universal scraper iterates through all countries automatically."
            config["_note"] = "This endpoint filters by country. To get all stores worldwide, iterate country-region (or country) param: US, IT, FR, DE, etc. Scraper uses comprehensive country list."
            config["use_watch_store_countries"] = True  # Use 88-country list for worldwide coverage
        elif endpoint_type == 'paginated':
            config["description"] += " - Universal scraper handles pagination automatically"
            config["_note"] = "This endpoint uses pagination. The universal scraper will automatically follow all pages."
        
        return config
    
    def _suggest_html_config(self, html_analysis: Dict, base_url: str) -> Dict:
        """Suggest HTML configuration"""
        config = {
            "type": "html",
            "url": base_url,
            "description": "HTML page with store data",
            "method": "GET"
        }
        
        source = html_analysis.get('source', '')
        if source == 'embedded_json':
            config["description"] += " - Contains embedded JSON data in script tags"
        elif source == 'data_attributes':
            config["description"] += " - Uses data attributes for coordinates"
            config["data_attributes"] = {
                "Latitude": "data-lat",
                "Longitude": "data-lng"
            }
        
        return config
    
    def _suggest_generic_config(self, endpoint: Dict, base_url: str) -> Dict:
        """Suggest generic configuration"""
        return {
            "type": endpoint.get('type', 'json'),
            "url": endpoint.get('url', base_url),
            "description": "Auto-detected endpoint - Review and customize",
            "method": "GET",
            "field_mapping": self._get_default_field_mapping()
        }
    
    def _detect_data_path(self, data: Any, current_path: str = "", depth: int = 0) -> str:
        """
        Detect the path to store data in nested JSON
        
        Args:
            data: JSON data
            current_path: Current path being built
            depth: Recursion depth
            
        Returns:
            Data path string (e.g., "data.stores" or "response.entities")
        """
        if depth > 5:
            return ""
        
        if isinstance(data, dict):
            # Look for store-related keys
            for key, value in data.items():
                key_lower = str(key).lower()
                if any(keyword in key_lower for keyword in ['store', 'location', 'retailer', 'establishment', 'entity', 'point']):
                    if isinstance(value, list) and len(value) > 0:
                        # Found array of stores
                        new_path = f"{current_path}.{key}" if current_path else key
                        return new_path
                    elif isinstance(value, dict):
                        # Might be nested, continue searching
                        new_path = f"{current_path}.{key}" if current_path else key
                        nested_path = self._detect_data_path(value, new_path, depth + 1)
                        if nested_path:
                            return nested_path
            
            # Recursively search
            for key, value in data.items():
                if isinstance(value, (dict, list)):
                    new_path = f"{current_path}.{key}" if current_path else key
                    nested_path = self._detect_data_path(value, new_path, depth + 1)
                    if nested_path:
                        return nested_path
        
        elif isinstance(data, list):
            # If it's a list, check if items are stores
            if len(data) > 0 and isinstance(data[0], dict):
                if self._has_store_fields(data[0]):
                    return current_path
        
        return ""
    
    def _extract_stores(self, data: Any, data_path: str) -> List[Dict]:
        """Extract stores from data using data_path"""
        if not data_path:
            # Try to find stores automatically
            if isinstance(data, list):
                return data if all(self._has_store_fields(item) for item in data[:3]) else []
            elif isinstance(data, dict):
                # Look for store arrays
                for key, value in data.items():
                    if isinstance(value, list) and len(value) > 0:
                        if self._has_store_fields(value[0]):
                            return value
                return []
            return []
        
        # Navigate using data_path
        parts = data_path.split('.')
        current = data
        
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list) and part.isdigit():
                current = current[int(part)]
            else:
                return []
            
            if current is None:
                return []
        
        if isinstance(current, list):
            return current
        elif isinstance(current, dict):
            return [current]
        
        return []
    
    def _detect_field_mapping_robust(self, stores: List[Dict]) -> Dict[str, Any]:
        """
        Detect field mappings from multiple sample stores (more robust)
        
        Args:
            stores: List of sample store dictionaries (check multiple for consistency)
            
        Returns:
            Field mapping dictionary
        """
        if not stores or len(stores) == 0:
            return {}
        
        # Flatten all stores to find common keys
        all_flat_stores = [self._flatten_dict(store) for store in stores]
        all_keys = set()
        for flat_store in all_flat_stores:
            all_keys.update(flat_store.keys())
        
        mapping = {}
        
        # Special handling for coordinate fields - dynamic detection based on field path patterns
        coordinate_fields = {
            "Latitude": {
                "keywords": ["lat", "latitude"],
                "suffixes": [".lat", ".latitude"],
                "range": (-90, 90)
            },
            "Longitude": {
                "keywords": ["lng", "longitude", "lon", "long"],
                "suffixes": [".lng", ".long", ".longitude", ".lon"],
                "range": (-180, 180)
            }
        }
        
        # Dynamic coordinate detection - find fields that match coordinate patterns
        for coord_field, coord_config in coordinate_fields.items():
            best_match = None
            best_score = 0
            
            # Strategy 1: Look for fields ending with coordinate suffixes (highest confidence)
            # e.g., "profile.geocodedCoordinate.lat", "location.latitude", "coordinates.long"
            # Prioritize fields that are actual store coordinates (geocodedCoordinate, yextDisplayCoordinate)
            # over city coordinates (cityCoordinate)
            coordinate_priority_terms = ["geocodedcoordinate", "yextdisplaycoordinate", "displaycoordinate", "coordinate", "geocode", "location"]
            coordinate_exclude_terms = ["citycoordinate"]  # Exclude city center coordinates
            
            sorted_keys_by_priority = sorted(all_keys, key=lambda k: (
                any(term in k.lower() for term in coordinate_priority_terms) and not any(exclude in k.lower() for exclude in coordinate_exclude_terms),
                not any(exclude in k.lower() for exclude in coordinate_exclude_terms),
                -len(k)
            ), reverse=True)
            
            for key in sorted_keys_by_priority:
                key_lower = key.lower()
                # Check if key ends with a coordinate suffix
                matches_suffix = any(key_lower.endswith(suffix.lower()) for suffix in coord_config["suffixes"])
                
                if matches_suffix:
                    # Verify it exists in all stores and is a valid coordinate
                    matches = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                    if matches == len(all_flat_stores):
                        sample_value = self._get_nested_value(all_flat_stores[0], key)
                        if self._is_valid_coordinate(sample_value):
                            try:
                                coord_val = float(sample_value)
                                min_val, max_val = coord_config["range"]
                                # Exclude boolean-like values (0, 1) unless in coordinate context
                                if coord_val in [0, 1] and not any(term in key_lower for term in ["coordinate", "geocode", "location", "geo", "lat", "lng", "long", "lon"]):
                                    continue
                                # Verify it's in valid coordinate range
                                if min_val <= coord_val <= max_val:
                                    # Higher score for preferred coordinate types
                                    if "geocodedcoordinate" in key_lower or "yextdisplaycoordinate" in key_lower:
                                        score = 1.0  # Highest confidence for geocoded/yext coordinates
                                    elif "citycoordinate" in key_lower:
                                        score = 0.5  # Lower score for city coordinates (city center, not store)
                                    else:
                                        score = 0.9  # High confidence for other coordinate types
                                    if score > best_score:
                                        best_match = key
                                        best_score = score
                            except (ValueError, TypeError):
                                pass
            
            # Strategy 2: Look for fields containing coordinate keywords in their path
            # e.g., "geocodedCoordinate.lat", "location.latitude", "coordinates.longitude"
            if not best_match:
                coord_priority_terms = ["coordinate", "geocode", "location", "geo", "position", "point"]
                sorted_keys = sorted(all_keys, key=lambda k: (
                    any(term in k.lower() for term in coord_priority_terms),
                    any(kw in k.lower() for kw in coord_config["keywords"]),
                    -len(k)
                ), reverse=True)
                
                for key in sorted_keys:
                    key_lower = key.lower()
                    has_coord_keyword = any(kw in key_lower for kw in coord_config["keywords"])
                    has_priority_term = any(term in key_lower for term in coord_priority_terms)
                    
                    # Must have coordinate keyword in path
                    if not has_coord_keyword:
                        continue
                    
                    # Verify it exists in all stores and is a valid coordinate
                    matches = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                    if matches == len(all_flat_stores):
                        sample_value = self._get_nested_value(all_flat_stores[0], key)
                        if self._is_valid_coordinate(sample_value):
                            try:
                                coord_val = float(sample_value)
                                min_val, max_val = coord_config["range"]
                                # Exclude boolean-like values (0, 1) unless in coordinate context
                                if coord_val in [0, 1] and not has_priority_term:
                                    continue
                                # Verify it's in valid coordinate range
                                if min_val <= coord_val <= max_val:
                                    # Higher score if it has priority terms (coordinate, geocode, etc.)
                                    score = 0.8 if has_priority_term else 0.6
                                    if score > best_score:
                                        best_match = key
                                        best_score = score
                            except (ValueError, TypeError):
                                pass
            
            # Strategy 3: Fallback - look for any numeric field in coordinate-related paths
            # Only if no better match found and field is in a coordinate-related context
            if not best_match:
                coord_related_terms = ["coordinate", "geocode", "location", "position", "point", "geo"]
                for key in all_keys:
                    key_lower = key.lower()
                    # Must be in a coordinate-related path
                    if not any(term in key_lower for term in coord_related_terms):
                        continue
                    # Skip if already checked (has coordinate keywords)
                    if any(kw in key_lower for kw in coord_config["keywords"]):
                        continue
                    
                    matches = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                    if matches == len(all_flat_stores):
                        sample_value = self._get_nested_value(all_flat_stores[0], key)
                        if self._is_valid_coordinate(sample_value):
                            try:
                                coord_val = float(sample_value)
                                min_val, max_val = coord_config["range"]
                                # Exclude boolean-like values
                                if coord_val in [0, 1]:
                                    continue
                                # Verify it's in valid coordinate range
                                if min_val <= coord_val <= max_val:
                                    score = 0.4  # Lower confidence for fallback
                                    if score > best_score:
                                        best_match = key
                                        best_score = score
                            except (ValueError, TypeError):
                                pass
            
            if best_match:
                mapping[coord_field] = best_match
        
        # Dynamic City field detection - similar to coordinates
        if "City" not in mapping:
            city_keywords = ["city", "cityname"]
            city_exclude_suffixes = [".lat", ".lng", ".latitude", ".longitude", ".long", ".lon", ".coord", ".coordinate"]
            city_priority_paths = ["address.city", "city", "cityname", "address.cityname"]
            
            best_city_match = None
            best_city_score = 0
            
            # Strategy 1: Look for fields in priority paths (highest confidence)
            for priority_path in city_priority_paths:
                matches = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, priority_path) is not None)
                if matches == len(all_flat_stores):
                    sample_value = self._get_nested_value(all_flat_stores[0], priority_path)
                    # City should be a string, not a number
                    if isinstance(sample_value, str) and sample_value.strip() and not sample_value.replace('.', '').replace('-', '').isdigit():
                        best_city_match = priority_path
                        best_city_score = 1.0
                        break
            
            # Strategy 2: Look for fields containing "city" keyword, excluding coordinate fields
            if not best_city_match:
                sorted_keys = sorted(all_keys, key=lambda k: (
                    any(path in k.lower() for path in city_priority_paths),
                    "address" in k.lower(),
                    -len(k)
                ), reverse=True)
                
                for key in sorted_keys:
                    key_lower = key.lower()
                    # Must contain city keyword
                    if not any(kw in key_lower for kw in city_keywords):
                        continue
                    # Exclude coordinate fields (ending with .lat, .lng, etc.)
                    if any(key_lower.endswith(suffix) for suffix in city_exclude_suffixes):
                        continue
                    # Exclude if it's clearly a coordinate field (contains coordinate/geocode AND lat/lng)
                    if any(term in key_lower for term in ["coordinate", "geocode"]) and any(term in key_lower for term in ["lat", "lng", "long"]):
                        continue
                    
                    matches = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                    if matches == len(all_flat_stores):
                        sample_value = self._get_nested_value(all_flat_stores[0], key)
                        # City should be a string, not a number
                        if isinstance(sample_value, str) and sample_value.strip():
                            # Exclude if it's numeric (coordinates)
                            if not sample_value.replace('.', '').replace('-', '').isdigit():
                                # Higher score if in address path
                                score = 0.9 if "address" in key_lower else 0.7
                                if score > best_city_score:
                                    best_city_match = key
                                    best_city_score = score
            
            if best_city_match:
                mapping["City"] = best_city_match
        
        # Optional fields: can be edited in admin if missing - use lower presence threshold
        OPTIONAL_FIELDS = ["Phone", "Email"]
        MIN_PRESENCE_OPTIONAL = 0.3  # Accept if present in >= 30% of stores

        # Second pass: Detect all other fields
        for canonical_field, patterns in self.FIELD_PATTERNS.items():
            # Skip coordinates and City (already handled)
            if canonical_field in coordinate_fields.keys() or canonical_field == "City":
                continue

            is_optional = canonical_field in OPTIONAL_FIELDS
            min_matches = len(all_flat_stores) if not is_optional else max(1, int(len(all_flat_stores) * MIN_PRESENCE_OPTIONAL))

            best_match = None
            best_score = 0.0
            best_presence = 0

            # First, try predefined patterns - match flexibly (pattern works for any nesting depth)
            for pattern in patterns:
                matching_keys = self._find_keys_matching_pattern(all_keys, pattern)
                for key in matching_keys:
                    presence = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                    if presence >= min_matches:
                        sample_val = next((self._get_nested_value(s, key) for s in all_flat_stores if self._get_nested_value(s, key) is not None), None)
                        # For Phone: prefer actual numbers over labels (c_phoneOrder.title -> "PHONE ORDER")
                        if canonical_field == "Phone" and not self._looks_like_phone(sample_val):
                            continue
                        # For Email: prefer values that look like email
                        if canonical_field == "Email" and sample_val and not self._looks_like_email(sample_val):
                            continue
                        # Prefer higher presence when quality is equal
                        if presence > best_presence or (presence == best_presence and 1.0 > best_score):
                            best_match = key
                            best_score = 1.0
                            best_presence = presence
                if best_match:
                    break  # Found match from predefined patterns

            # If no predefined pattern matched, search all keys - prefer quality over presence
            if not best_match:
                for key in all_keys:
                    score = self._calculate_field_similarity(canonical_field, key)
                    if score >= 0.6:
                        presence = sum(1 for flat_store in all_flat_stores if self._get_nested_value(flat_store, key) is not None)
                        if presence >= min_matches:
                            sample_val = next((self._get_nested_value(s, key) for s in all_flat_stores if self._get_nested_value(s, key) is not None), None)
                            if canonical_field == "Phone" and not self._looks_like_phone(sample_val):
                                continue
                            if canonical_field == "Email" and sample_val and not self._looks_like_email(sample_val):
                                continue
                            # Prefer: higher quality score, then higher presence
                            if (score > best_score) or (score == best_score and presence > best_presence):
                                best_match = key
                                best_score = score
                                best_presence = presence

            if best_match:
                mapping[canonical_field] = best_match
        
        return mapping
    
    def _looks_like_phone(self, value: Any) -> bool:
        """Check if value looks like a real phone number, not a label (e.g. 'PHONE ORDER')"""
        if value is None:
            return False
        s = str(value).strip()
        if not s:
            return False
        # Handle arrays (e.g. from API) - take first element
        if isinstance(value, list) and value:
            return self._looks_like_phone(value[0])
        # Labels like "PHONE ORDER", "READ MORE" - no digits or very few
        digit_count = sum(1 for c in s if c.isdigit())
        if digit_count < 5:  # Real phone has at least 5+ digits
            return False
        # Reject known label patterns
        reject_patterns = ["phone order", "read more", "click", "contact us"]
        if any(p in s.lower() for p in reject_patterns):
            return False
        return True

    def _looks_like_email(self, value: Any) -> bool:
        """Check if value looks like an email address (has @ and domain)"""
        if value is None:
            return False
        if isinstance(value, list) and value:
            return self._looks_like_email(value[0])
        s = str(value).strip()
        if not s or len(s) < 5:
            return False
        if "@" not in s or "." not in s.split("@")[-1]:
            return False
        # Reject URLs and labels
        if s.startswith("http") or " " in s:
            return False
        return True

    def _is_valid_coordinate(self, value: Any) -> bool:
        """Check if a value is a valid coordinate (number)"""
        if value is None:
            return False
        try:
            num = float(value)
            # Coordinates should be reasonable (latitude: -90 to 90, longitude: -180 to 180)
            # But we'll be lenient and just check if it's a number
            return True
        except (ValueError, TypeError):
            return False
    
    def _get_nested_value(self, flat_dict: Dict, key_path: str) -> Any:
        """Get value from flattened dict using dot notation"""
        if key_path in flat_dict:
            value = flat_dict[key_path]
            # Return value even if it's 0, False, or empty string (but not None)
            return value
        return None

    def _find_keys_matching_pattern(self, all_keys: set, pattern: str) -> List[str]:
        """
        Find keys that match a pattern - works for any API nesting (profile.X, response.X, etc).
        Matches: exact key, or key ending with .pattern (e.g. mainPhone.display matches profile.mainPhone.display)
        """
        pattern_lower = pattern.lower()
        pattern_dotted = pattern_lower.replace("_", ".")
        matches = []
        for key in all_keys:
            key_lower = key.lower().replace("_", ".")
            if key_lower == pattern_dotted:
                matches.append(key)
            elif key_lower.endswith("." + pattern_dotted):
                matches.append(key)
        return matches
    
    def _calculate_field_similarity(self, canonical_field: str, candidate_key: str) -> float:
        """
        Calculate similarity between canonical field name and candidate key
        
        Args:
            canonical_field: Canonical field name (e.g., "Address Line 1")
            candidate_key: Candidate key from data (e.g., "address.line1")
            
        Returns:
            Similarity score 0.0-1.0
        """
        # Normalize both
        canonical_norm = canonical_field.lower().replace(' ', '').replace('/', '').replace('-', '')
        candidate_norm = candidate_key.lower().replace('_', '').replace('.', '').replace('-', '')
        
        # Extract key parts
        canonical_parts = set(re.findall(r'[a-z]+', canonical_norm))
        candidate_parts = set(re.findall(r'[a-z]+', candidate_norm))
        
        # Check for exact match
        if canonical_norm == candidate_norm:
            return 1.0
        
        # Check if canonical parts are all in candidate (e.g., "addressline1" in "addressline1")
        if canonical_parts.issubset(candidate_parts) or candidate_parts.issubset(canonical_parts):
            return 0.9
        
        # Check overlap
        if canonical_parts & candidate_parts:
            overlap = len(canonical_parts & candidate_parts)
            total = len(canonical_parts | candidate_parts)
            return overlap / total if total > 0 else 0.0
        
        # Check substring match
        if canonical_norm in candidate_norm or candidate_norm in canonical_norm:
            return 0.7
        
        return 0.0
    
    def _detect_field_mapping(self, store: Dict) -> Dict[str, Any]:
        """
        Detect field mappings from a sample store object (legacy method - calls robust version)
        
        Args:
            store: Sample store dictionary
            
        Returns:
            Field mapping dictionary
        """
        return self._detect_field_mapping_robust([store])
    
    def _flatten_dict(self, d: Dict, parent_key: str = '', sep: str = '.') -> Dict:
        """Flatten nested dictionary"""
        items = []
        for k, v in d.items():
            new_key = f"{parent_key}{sep}{k}" if parent_key else k
            if isinstance(v, dict):
                items.extend(self._flatten_dict(v, new_key, sep=sep).items())
            elif isinstance(v, list) and len(v) > 0 and isinstance(v[0], dict):
                # Handle list of dicts - use index notation
                for i, item in enumerate(v):
                    items.extend(self._flatten_dict(item, f"{new_key}.{i}", sep=sep).items())
            else:
                items.append((new_key, v))
        return dict(items)
    
    def _has_store_fields(self, obj: Dict) -> bool:
        """Check if object has store-related fields"""
        keys = ' '.join(str(k).lower() for k in obj.keys())
        required = ['address', 'lat', 'lng', 'latitude', 'longitude', 'city', 'name']
        found = sum(1 for field in required if field in keys)
        return found >= 2
    
    def _parse_url_params(self, url: str) -> Dict[str, str]:
        """Parse URL parameters into a dictionary"""
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        # Convert lists to single values (most params are single-valued)
        return {k: v[0] if isinstance(v, list) and len(v) > 0 else v for k, v in params.items()}
    
    def _build_optimized_radius_url(self, url: str, endpoint: Dict) -> str:
        """
        Build an optimized URL for radius-based endpoints with:
        - A default center point (Paris) if missing
        - Large radius (2000km) if not already set
        - Pagination parameters (offset=0, per=50) if pagination is detected
        
        Args:
            url: Original URL
            endpoint: Endpoint dictionary with type and params info
            
        Returns:
            Optimized URL string
        """
        from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
        
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        
        # Default center point (Paris) - good for worldwide coverage
        default_center = "48.8566,2.3522"  # Paris coordinates
        
        # Check for radius parameters
        radius_key = None
        for key in ['r', 'radius', 'distance']:
            if key in params:
                radius_key = key
                break
        
        # If no radius param found, check if endpoint type is radius (might use different param name)
        if not radius_key and endpoint.get('type') == 'radius':
            # Try to infer from URL or use 'r' as default
            radius_key = 'r'
        
        # Set large radius (2000km) if not already set or if current value is small
        if radius_key:
            current_radius = params.get(radius_key, [''])[0] if isinstance(params.get(radius_key), list) else params.get(radius_key, '')
            try:
                radius_val = float(current_radius) if current_radius else 0
                # If radius is less than 1000, use 2000
                if radius_val < 1000:
                    params[radius_key] = ['2000']
                elif not current_radius:
                    params[radius_key] = ['2000']
            except (ValueError, TypeError):
                # If radius value is invalid, set to 2000
                params[radius_key] = ['2000']
        else:
            # Add radius parameter if missing
            params['r'] = ['2000']
        
        # Check for center point parameter (q, center, lat/lng, etc.)
        center_key = None
        for key in ['q', 'center', 'lat', 'lng', 'latitude', 'longitude']:
            if key in params:
                center_key = key
                break
        
        # If no center point, add one (use 'q' as it's common for radius searches)
        if not center_key:
            params['q'] = [default_center]
        else:
            # Check if center point is valid (should be coordinates)
            current_center = params.get(center_key, [''])[0] if isinstance(params.get(center_key), list) else params.get(center_key, '')
            if not current_center or (not ',' in str(current_center) and not any(c.isdigit() for c in str(current_center))):
                # Invalid or missing center point, use default
                if center_key == 'q':
                    params['q'] = [default_center]
                else:
                    # Use 'q' as the standard parameter name
                    params['q'] = [default_center]
        
        # Check for pagination parameters
        pagination_params = ['offset', 'per', 'per_page', 'limit', 'page']
        has_pagination = any(p in params for p in pagination_params)
        # Yext-style APIs (response.entities) support per and offset for pagination
        data_path = endpoint.get('data_path', '') or ''
        is_yext_style = 'response.entities' in data_path or 'entities' in data_path
        
        # Add pagination if detected, or for Yext-style radius APIs (e.g. Bell & Ross)
        if has_pagination or endpoint.get('type') == 'paginated' or 'paginated' in endpoint.get('indicators', []) or (endpoint.get('type') == 'radius' and is_yext_style):
            # Set offset to 0 (start from beginning)
            if 'offset' in params:
                params['offset'] = ['0']
            elif 'page' in params:
                params['page'] = ['0']
            
            # Set per_page/limit to a reasonable value (50)
            if 'per' in params:
                current_per = params.get('per', [''])[0] if isinstance(params.get('per'), list) else params.get('per', '')
                if not current_per or (current_per.isdigit() and int(current_per) < 50):
                    params['per'] = ['50']
            elif 'per_page' in params:
                current_per = params.get('per_page', [''])[0] if isinstance(params.get('per_page'), list) else params.get('per_page', '')
                if not current_per or (current_per.isdigit() and int(current_per) < 50):
                    params['per_page'] = ['50']
            elif 'limit' in params:
                current_limit = params.get('limit', [''])[0] if isinstance(params.get('limit'), list) else params.get('limit', '')
                if not current_limit or (current_limit.isdigit() and int(current_limit) < 50):
                    params['limit'] = ['50']
            else:
                # Add 'per' parameter if pagination is detected but no limit param exists
                params['per'] = ['50']
                params['offset'] = ['0']
        
        # Rebuild URL with optimized parameters
        query_string = urlencode(params, doseq=True)
        optimized_url = urlunparse((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            query_string,
            parsed.fragment
        ))
        
        return optimized_url
    
    def _get_default_field_mapping(self) -> Dict[str, List[str]]:
        """Get default field mapping with common patterns"""
        return {
            "Name": ["name", "nameTranslated", "shortName", "establishment_name"],
            "Address Line 1": ["streetAddress", "shortAddress", "address", "address1"],
            "City": ["cityName", "city"],
            "State/Province/Region": ["regionName", "state", "province"],
            "Country": ["countryName", "country", "countryCode"],
            "Postal/ZIP Code": ["postalCode", "zipCode", "zip"],
            "Phone": ["phone1", "phone", "phoneNumber"],
            "Email": ["email", "contact_email"],
            "Website": ["website", "url"],
            "Latitude": ["lat", "latitude"],
            "Longitude": ["lng", "longitude"]
        }

