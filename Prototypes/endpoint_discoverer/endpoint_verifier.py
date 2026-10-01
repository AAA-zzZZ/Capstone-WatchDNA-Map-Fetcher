#!/usr/bin/env python3
"""Verifies discovered endpoints using existing scraping methods."""

import sys
import os
from typing import Dict, List, Optional, Any
from urllib.parse import urlparse, parse_qs

DISCOVERY_SAMPLE_LIMIT = 15

_PAGE_SIZE_KEYS = frozenset({'limit', 'per', 'per_page', 'take', 'page_size', 'count', 'pagesize'})

# Verified responses from these URLs are often nested product/page context — not locator APIs.
_MIN_STORES_TO_TRUST_SUSPICIOUS_HOST = 5


def _is_suspected_tracking_or_personalization_url(url: str) -> bool:
    if not url:
        return False
    u = url.lower()
    if 'cquotient.com' in u or 'commercecloudanalytics' in u:
        return True
    if 'activitytype=viewpage' in u.replace(' ', '') or 'activity_type=viewpage' in u.replace(' ', ''):
        return True
    return False


def _url_with_sample_limit(url: str, limit: int = DISCOVERY_SAMPLE_LIMIT) -> str:
    parsed = urlparse(url)
    params = parse_qs(parsed.query, keep_blank_values=True)
    keys_lower = {k.lower() for k in params.keys()}
    if keys_lower & _PAGE_SIZE_KEYS:
        return url
    sep = '&' if parsed.query else '?'
    return f"{url}{sep}limit={limit}"

_current_dir = os.path.dirname(os.path.abspath(__file__))
_parent_dir = os.path.dirname(_current_dir)
_data_scrappers_dir = os.path.join(_parent_dir, 'Data_Scrappers')
if _data_scrappers_dir not in sys.path:
    sys.path.insert(0, _data_scrappers_dir)
if _current_dir not in sys.path:
    sys.path.insert(0, _current_dir)

try:
    cached_pattern = None
    if 'pattern_detector' in sys.modules:
        pattern_mod = sys.modules['pattern_detector']
        if hasattr(pattern_mod, 'PatternDetector') and not hasattr(pattern_mod, 'detect_data_pattern'):
            cached_pattern = sys.modules.pop('pattern_detector')
    
    try:
        from universal_scraper import fetch_data, scrape_single_call, extract_stores_from_html_js
        from locator_type_detector import detect_locator_type
        SCRAPING_METHODS_AVAILABLE = True
        import_error_msg = None
    finally:
        if cached_pattern:
            sys.modules['pattern_detector'] = cached_pattern
except ImportError as e:
    SCRAPING_METHODS_AVAILABLE = False
    _import_error = str(e)
    import traceback
    _import_traceback = traceback.format_exc()
    fetch_data = None
    scrape_single_call = None
    extract_stores_from_html_js = None
    detect_locator_type = None
    import_error_msg = f"Import failed: {_import_error}"


detect_data_pattern = None
if SCRAPING_METHODS_AVAILABLE and 'pattern_detector' not in sys.modules:
    try:
        # Import from parent directory before local one gets loaded
        import importlib.util
        parent_pattern_detector_path = os.path.join(_data_scrappers_dir, 'pattern_detector.py')
        if os.path.exists(parent_pattern_detector_path):
            spec = importlib.util.spec_from_file_location("parent_pattern_detector_module", parent_pattern_detector_path)
            parent_pattern_module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(parent_pattern_module)
            detect_data_pattern = getattr(parent_pattern_module, 'detect_data_pattern', None)
    except Exception:
        # If that fails, it's OK - detect_data_pattern is optional
        detect_data_pattern = None


class EndpointVerifier:
    """Verify endpoints using existing scraping methods"""
    
    def __init__(self, cache_results: bool = True):
        """
        Initialize verifier
        
        Args:
            cache_results: Cache verification results to avoid re-testing
        """
        self.cache_results = cache_results
        self.verification_cache = {}  # url -> verification_result
    
    def optimize_radius_endpoint(self, url: str, custom_headers: Dict = None, timeout: int = 10) -> Dict[str, Any]:
        """
        Optimize a radius-based endpoint by trying different radius values and pagination
        
        For radius-based endpoints, the discovered URL might have a small radius (e.g., r=124.3).
        This method tries larger radius values (500, 1000, 2000, 5000) and pagination to find
        the variant that returns the most stores.
        
        Args:
            url: Original endpoint URL with radius parameter
            custom_headers: Optional custom headers
            timeout: Request timeout
            
        Returns:
            Dict with:
            {
                'optimized_url': str,  # Best URL variant found
                'original_url': str,   # Original URL
                'best_store_count': int,  # Store count from best variant
                'radius_used': str,    # Radius value that worked best
                'tested_variants': List[Dict],  # All variants tested
                'success': bool
            }
        """
        from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
        
        result = {
            'optimized_url': url,
            'original_url': url,
            'best_store_count': 0,
            'radius_used': None,
            'tested_variants': [],
            'success': False
        }
        
        if not SCRAPING_METHODS_AVAILABLE:
            return result
        
        # Parse URL
        parsed = urlparse(url)
        params = parse_qs(parsed.query, keep_blank_values=True)
        
        # Check if this is a radius-based endpoint
        radius_params = ['r', 'radius', 'distance']
        has_radius = any(p in params for p in radius_params)
        
        if not has_radius:
            # Not a radius endpoint, return original
            return result
        
        # Get current radius value (if any)
        current_radius = None
        radius_key = None
        for key in radius_params:
            if key in params:
                radius_key = key
                current_radius = params[key][0] if params[key] else None
                break
        
        # Radius values to try (once we've locked a config, we only vary this)
        radius_values_ascending = [500, 1000, 2000, 5000, 10000, 25000]
        
        # Also check for pagination parameters
        pagination_params = ['offset', 'per', 'per_page', 'limit', 'page']
        has_pagination = any(p in params for p in pagination_params)
        
        # Center point strategies (order: try first, lock when one returns data)
        center_strategies = []
        has_lat_long = 'lat' in params or 'latitude' in params
        has_q_center = 'q' in params or 'center' in params
        
        if has_lat_long:
            current_lat = params.get('lat', params.get('latitude', ['0']))[0] if isinstance(params.get('lat', params.get('latitude', ['0'])), list) else params.get('lat', params.get('latitude', '0'))
            current_long = params.get('long', params.get('longitude', ['0']))[0] if isinstance(params.get('long', params.get('longitude', ['0'])), list) else params.get('long', params.get('longitude', '0'))
            center_strategies.append(('lat_long', current_lat, current_long))
            center_strategies.append(('lat_long', '0', '0'))
        elif has_q_center:
            current_q = params.get('q', params.get('center', ['']))[0] if isinstance(params.get('q', params.get('center', [''])), list) else params.get('q', params.get('center', ''))
            if current_q:
                center_strategies.append(('q', current_q))
            center_strategies.append(('q', '48.8566,2.3522'))
            center_strategies.append(('lat_long', '0', '0'))
        else:
            center_strategies.append(('lat_long', '0', '0'))
            center_strategies.append(('q', '48.8566,2.3522'))
        
        # Pagination strategies (order: try first, lock when config returns data)
        pagination_strategies = []
        if has_pagination:
            if 'offset' in params:
                pagination_strategies.append(('per', 'offset', '50', '0'))
            elif 'per' in params:
                pagination_strategies.append(('per', 'offset', '50', '0'))
            elif 'per_page' in params:
                pagination_strategies.append(('per_page', 'offset', '50', '0'))
            elif 'limit' in params:
                pagination_strategies.append(('limit', 'offset', '50', '0'))
        pagination_strategies.extend([
            ('per', 'offset', '50', '0'),
            ('per_page', 'offset', '50', '0'),
            ('limit', 'offset', '50', '0'),
            (None, None, None, None)
        ])
        seen = set()
        pagination_strategies = [s for s in pagination_strategies if s not in seen and not seen.add(s)]
        
        def build_test_url(radius_val, center_strategy, pagination_strategy):
            """Build URL for one (radius, center, pagination) combo."""
            test_params = params.copy()
            test_params[radius_key] = [str(radius_val)]
            for key in ['qp', 'query', 'location', 'address']:
                if key in test_params:
                    del test_params[key]
            if center_strategy[0] == 'lat_long':
                test_params['lat'] = [center_strategy[1]]
                test_params['long'] = [center_strategy[2]]
                for key in ['q', 'center', 'lng', 'latitude', 'longitude']:
                    if key in test_params:
                        del test_params[key]
            else:
                test_params['q'] = [center_strategy[1]]
                for key in ['lat', 'lng', 'latitude', 'longitude', 'center']:
                    if key in test_params:
                        del test_params[key]
            if pagination_strategy[0] is not None:
                for key in ['offset', 'per', 'per_page', 'limit', 'page', 'pageToken']:
                    if key in test_params:
                        del test_params[key]
                limit_key, offset_key, limit_val, offset_val = pagination_strategy
                test_params[limit_key] = [limit_val]
                test_params[offset_key] = [offset_val]
            test_query = urlencode(test_params, doseq=True)
            return urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, test_query, parsed.fragment))
        
        # --- Phase 1: Find first (center + pagination) that returns any store data ---
        # Use a single probe radius (e.g. 2000) so we don't switch configs based on radius
        probe_radius = 2000
        locked_center = None
        locked_pagination = None
        
        for center_strategy in center_strategies:
            if locked_center is not None:
                break
            for pagination_strategy in pagination_strategies:
                test_url = build_test_url(probe_radius, center_strategy, pagination_strategy)
                try:
                    verification = self.quick_verify(test_url, custom_headers=custom_headers, timeout=timeout)
                    store_count = verification.get('store_count', 0) or 0
                    result['tested_variants'].append({
                        'url': test_url, 'radius': str(probe_radius), 'center': str(center_strategy[:2]),
                        'pagination': str(pagination_strategy), 'store_count': store_count, 'success': verification.get('success', False)
                    })
                    if store_count > 0:
                        locked_center = center_strategy
                        locked_pagination = pagination_strategy
                        locked_initial_count = store_count
                        center_desc = f"lat={center_strategy[1]}&long={center_strategy[2]}" if center_strategy[0] == 'lat_long' else f"q={center_strategy[1]}"
                        print(f"      ✓ Found working config: {center_desc}, pagination={pagination_strategy[:2] if pagination_strategy[0] else 'none'} → {store_count} stores (locking, will only vary radius)")
                        break
                except Exception as e:
                    result['tested_variants'].append({
                        'url': test_url, 'radius': str(probe_radius), 'store_count': 0, 'success': False, 'error': str(e)[:80]
                    })
            else:
                continue
            break
        
        if locked_center is None:
            # No config returned data; return best attempt if any
            best_variant = max(result['tested_variants'], key=lambda v: (v.get('success', False), float(v.get('radius', 0))))
            if best_variant.get('url'):
                result['optimized_url'] = best_variant['url']
                result['radius_used'] = best_variant.get('radius')
                result['center_used'] = best_variant.get('center', 'N/A')
                result['best_store_count'] = best_variant.get('store_count', 0)
            print(f"      ⚠️  No configuration returned store data")
            return result
        
        # --- Phase 2: Keep same config, only increase radius to get max stores ---
        best_url = None
        best_count = 0
        best_radius = None
        center_desc = f"lat={locked_center[1]}&long={locked_center[2]}" if locked_center[0] == 'lat_long' else f"q={locked_center[1]}"
        pagination_desc = f", {locked_pagination[0]}={locked_pagination[2]}&{locked_pagination[1]}={locked_pagination[3]}" if locked_pagination[0] else ""
        
        print(f"      🔒 Varying only radius (same center + pagination) to maximize stores...")
        for radius_val in radius_values_ascending:
            test_url = build_test_url(radius_val, locked_center, locked_pagination)
            try:
                verification = self.quick_verify(test_url, custom_headers=custom_headers, timeout=timeout)
                store_count = verification.get('store_count', 0) or 0
                result['tested_variants'].append({
                    'url': test_url, 'radius': str(radius_val), 'center': center_desc, 'pagination': pagination_desc,
                    'store_count': store_count, 'success': verification.get('success', False)
                })
                if store_count > best_count:
                    best_count = store_count
                    best_url = test_url
                    best_radius = str(radius_val)
                    print(f"      ✓ radius={radius_val} → {store_count} stores")
            except Exception as e:
                result['tested_variants'].append({
                    'url': test_url, 'radius': str(radius_val), 'store_count': 0, 'success': False, 'error': str(e)[:80]
                })
        
        if best_url and best_count > 0:
            result['optimized_url'] = best_url
            result['best_store_count'] = best_count
            result['radius_used'] = best_radius
            result['center_used'] = center_desc + pagination_desc
            result['success'] = True
            print(f"      ✅ Using single config with radius={best_radius}: {best_count} stores")
        else:
            # Fallback: use the config we locked with probe radius (Phase 2 had no successful radius try)
            result['optimized_url'] = build_test_url(probe_radius, locked_center, locked_pagination)
            result['best_store_count'] = locked_initial_count
            result['radius_used'] = str(probe_radius)
            result['center_used'] = center_desc + pagination_desc
            result['success'] = True
        
        successful_configs = sum(1 for v in result['tested_variants'] if v.get('success', False) and v.get('store_count', 0) > 0)
        print(f"      📊 Locked 1 config, tested {len(radius_values_ascending)} radius values: {successful_configs} ok, max {best_count or result.get('best_store_count', 0)} stores")
        return result
    
    def quick_verify(self, url: str, custom_headers: Dict = None, timeout: int = 10) -> Dict[str, Any]:
        """
        Quickly verify an endpoint - fetch sample, count stores, detect type
        
        This is lightweight - just gets a sample, doesn't do full scraping.
        
        Args:
            url: Endpoint URL to verify
            custom_headers: Optional custom headers
            timeout: Request timeout
            
        Returns:
            Dict with verification results:
            {
                'success': bool,
                'store_count': int or None,
                'detected_type': str,
                'is_region_specific': bool,
                'sample_stores': List[Dict],  # First 3 stores as preview
                'data_path': str,  # Path to store data in response
                'field_mapping': Dict,  # Detected field mappings
                'error': str or None,
                'verification_time': float
            }
        """
        import time
        start_time = time.time()
        
        # Check cache
        cache_key = f"{url}|{str(custom_headers)}"
        if self.cache_results and cache_key in self.verification_cache:
            cached = self.verification_cache[cache_key].copy()
            cached['cached'] = True
            return cached
        
        result = {
            'success': False,
            'url': url,
            'store_count': None,
            'detected_type': 'unknown',
            'is_region_specific': False,
            'sample_stores': [],
            'data_path': '',
            'field_mapping': {},
            'error': None,
            'verification_time': 0,
            'cached': False
        }
        
        # Check if scraping methods are available
        if not SCRAPING_METHODS_AVAILABLE:
            # Get the actual import error message
            error_msg = globals().get('import_error_msg', "Scraping methods not available (import failed)")
            result['error'] = error_msg
            result['verification_time'] = time.time() - start_time
            return result
        
        try:
            # Step 1: Fetch sample data. Try limited URL first to avoid 1600+ store downloads.
            sample_data = None
            try:
                limited_url = _url_with_sample_limit(url)
                if limited_url != url:
                    try:
                        sample_data = fetch_data(limited_url, headers=custom_headers, timeout=min(timeout, 15))
                        # Verify we got stores (limit param may not be supported)
                        if isinstance(sample_data, (list, dict)):
                            stores_check = sample_data if isinstance(sample_data, list) else None
                            if not stores_check and isinstance(sample_data, dict):
                                for key in ["entities", "data", "results", "stores", "locations"]:
                                    if key in sample_data and isinstance(sample_data[key], list):
                                        stores_check = sample_data[key]
                                        break
                            if not stores_check or len(stores_check) == 0:
                                sample_data = None  # Limit returned empty, retry full URL
                    except Exception:
                        sample_data = None
                if sample_data is None:
                    sample_data = fetch_data(url, headers=custom_headers, timeout=timeout)
            except Exception as e:
                result['error'] = f"Failed to fetch: {str(e)[:200]}"
                result['verification_time'] = time.time() - start_time
                return result
            
            # If we got HTML (string or dict with 'html') but URL looks like a store API,
            # retry with Accept: application/json - many store locators (e.g. Bell & Ross) return JSON only with this header
            url_lower = url.lower()
            got_html = (
                (isinstance(sample_data, dict) and sample_data.get('html'))
                or (isinstance(sample_data, str) and len(sample_data) > 500 and ('<!' in sample_data or '<html' in sample_data.lower()))
            )
            if got_html and any(x in url_lower for x in ['/search', 'stores.', 'store.', 'locator', '/api/']):
                json_headers = dict(custom_headers) if custom_headers else {}
                json_headers['Accept'] = 'application/json'
                try:
                    json_data = fetch_data(url, headers=json_headers, timeout=timeout)
                    if isinstance(json_data, (list, dict)) and (not isinstance(json_data, dict) or 'html' not in json_data):
                        sample_data = json_data
                        if custom_headers is None:
                            custom_headers = {}
                        custom_headers = dict(custom_headers)
                        custom_headers['Accept'] = 'application/json'
                except Exception:
                    pass
            
            # Step 2: Detect locator type using existing method
            try:
                locator_analysis = detect_locator_type(url, sample_data)
                result['detected_type'] = locator_analysis.get('detected_type', 'unknown')
                result['is_region_specific'] = locator_analysis.get('is_region_specific', False)
            except Exception as e:
                result['error'] = f"Type detection failed: {str(e)[:200]}"
                # Continue anyway
            
            # Step 3: Extract stores using existing method (lightweight - just count, don't normalize)
            stores = []
            try:
                # Use the same logic as universal_scraper but lightweight
                if isinstance(sample_data, (list, dict)):
                    if isinstance(sample_data, list):
                        stores = sample_data
                    else:
                        # Find data array in dict (same logic as scrape_single_call)
                        nested_paths = ["response.entities", "response.data", "response.results", 
                                       "response.stores", "data.stores", "data.results"]
                        for path in nested_paths:
                            keys = path.split('.')
                            value = sample_data
                            for k in keys:
                                if isinstance(value, dict) and k in value:
                                    value = value[k]
                                else:
                                    break
                            else:
                                if isinstance(value, list):
                                    stores = value
                                    result['data_path'] = path
                                    break
                        
                        # Try direct keys
                        if not stores:
                            for key in ["entities", "data", "results", "items", "stores", "locations", "dealers", "retailers"]:
                                if key in sample_data and isinstance(sample_data[key], list):
                                    stores = sample_data[key]
                                    result['data_path'] = key
                                    break
                
                # Try HTML extraction if JSON didn't work
                if not stores and isinstance(sample_data, str):
                    stores = extract_stores_from_html_js(sample_data)
                
            except Exception as e:
                result['error'] = f"Store extraction failed: {str(e)[:200]}"
            
            # Step 4: Count and sample stores
            if stores:
                result['store_count'] = len(stores)
                result['sample_stores'] = stores[:3]  # First 3 as preview
                result['success'] = True
                
                # Step 5: Detect field mapping (lightweight - just detect, don't normalize)
                if stores and len(stores) > 0 and detect_data_pattern:
                    try:
                        pattern = detect_data_pattern(url, sample_data)
                        result['field_mapping'] = pattern.get('field_mapping', {})
                    except:
                        pass  # Field mapping detection is optional
            
        except Exception as e:
            result['error'] = f"Verification error: {str(e)[:200]}"
        
        result['verification_time'] = time.time() - start_time
        
        # Cache result
        if self.cache_results:
            self.verification_cache[cache_key] = result.copy()
        
        return result
    
    def verify_multiple(self, endpoints: List[Dict]) -> List[Dict]:
        """
        Verify multiple endpoints efficiently.

        HTML-type endpoints are skipped — they are already handled by the
        discoverer's _analyze_html_content and re-downloading the full page
        is expensive (e.g. Omega's 1400-store HTML).

        Stops early once a high-confidence verified endpoint is found so
        lower-confidence candidates don't trigger unnecessary HTTP requests.

        Args:
            endpoints: List of endpoint dicts with 'url' key

        Returns:
            List of endpoints with verification results added
        """
        verified_endpoints = []
        # Only "trusted" verifications should trigger early-skip of lower-confidence candidates.
        # A CQuotient beacon can verify with 2 bogus stores and must not skip the real /dw/shop/ URL.
        best_trusted_verified_count = 0

        for endpoint in endpoints:
            url = endpoint.get('url', '')

            # If endpoint has no URL, mark it as failed verification but still include it
            if not url:
                endpoint.update({
                    'verified': False,
                    'verified_store_count': 0,
                    'verified_type': None,
                    'verified_is_region_specific': False,
                    'verification_error': 'Missing or empty URL',
                    'verification_time': 0,
                    'sample_stores': [],
                    'data_path': '',
                    'field_mapping': {}
                })
                if 'indicators' not in endpoint:
                    endpoint['indicators'] = []
                endpoint['indicators'].append('missing_url')
                verified_endpoints.append(endpoint)
                continue

            # HTML endpoints are already handled by _analyze_html_content; skip
            # re-downloading them here to avoid fetching multi-MB pages.
            if endpoint.get('type') == 'html':
                endpoint.update({
                    'verified': True,
                    'verified_store_count': endpoint.get('store_count') or 0,
                    'verified_type': 'html',
                    'verified_is_region_specific': False,
                    'verification_error': None,
                    'verification_time': 0,
                    'sample_stores': [],
                    'data_path': '',
                    'field_mapping': {}
                })
                if 'indicators' not in endpoint:
                    endpoint['indicators'] = []
                verified_endpoints.append(endpoint)
                continue

            # Early exit: a high-confidence verified result means remaining
            # lower-confidence candidates are unlikely to be better.
            if best_trusted_verified_count > 0 and endpoint.get('confidence', 0) < 0.8:
                endpoint.update({
                    'verified': False,
                    'verified_store_count': 0,
                    'verified_type': None,
                    'verified_is_region_specific': False,
                    'verification_error': 'Skipped: higher-confidence endpoint already verified',
                    'verification_time': 0,
                    'sample_stores': [],
                    'data_path': '',
                    'field_mapping': {}
                })
                if 'indicators' not in endpoint:
                    endpoint['indicators'] = []
                verified_endpoints.append(endpoint)
                continue
            
            # Extract custom headers if present
            custom_headers = endpoint.get('headers') or endpoint.get('custom_headers')
            if custom_headers is None:
                custom_headers = {}
            else:
                custom_headers = dict(custom_headers)
            # Many store locator APIs (Bell & Ross, Breitling, etc.) return JSON only with Accept: application/json
            if any(domain in url.lower() for domain in ['stores.bellross.com', 'store.breitling.com', 'stores.']):
                custom_headers.setdefault('Accept', 'application/json')
            
            # Check if this is a radius-based endpoint that might need optimization.
            # max_distance is SFCC's radius param; also skip SFCC /dw/shop/stores since
            # they need lat+lng at runtime and are optimized by pattern_detector instead.
            parsed = urlparse(url)
            params = parse_qs(parsed.query, keep_blank_values=True)
            is_sfcc = '/dw/shop/' in parsed.path.lower() and '/stores' in parsed.path.lower()
            radius_params = ['r', 'radius', 'distance']
            is_radius_endpoint = not is_sfcc and any(p in params for p in radius_params)
            
            # For radius endpoints, try optimizing first
            optimized_url = url
            if is_radius_endpoint:
                try:
                    print(f"   🔍 Optimizing radius endpoint: systematically testing configurations...")
                    print(f"      (Like manually testing: trying each radius/center/pagination combo until one works)")
                    optimization = self.optimize_radius_endpoint(url, custom_headers=custom_headers, timeout=10)
                    if optimization.get('success') and optimization.get('best_store_count', 0) > 0:
                        optimized_url = optimization['optimized_url']
                        endpoint['original_url'] = url  # Keep original for reference
                        endpoint['optimized_url'] = optimized_url
                        endpoint['optimization_info'] = {
                            'radius_used': optimization.get('radius_used'),
                            'center_used': optimization.get('center_used'),
                            'tested_variants': len(optimization.get('tested_variants', [])),
                            'best_store_count': optimization.get('best_store_count')
                        }
                        print(f"   ✓ Found best variant: radius={optimization.get('radius_used')}, center={optimization.get('center_used', 'N/A')}, stores={optimization.get('best_store_count', 0)}")
                    elif optimization.get('optimized_url') != url:
                        # Even if no stores found, use optimized URL if it's different
                        optimized_url = optimization['optimized_url']
                        endpoint['original_url'] = url
                        endpoint['optimized_url'] = optimized_url
                        endpoint['optimization_info'] = {
                            'radius_used': optimization.get('radius_used'),
                            'center_used': optimization.get('center_used'),
                            'tested_variants': len(optimization.get('tested_variants', []))
                        }
                except Exception as e:
                    # If optimization fails, continue with original URL
                    print(f"   ⚠️  Radius optimization failed: {str(e)[:100]}")
                    pass
            
            # Quick verify (using optimized URL if available)
            verification = self.quick_verify(optimized_url, custom_headers=custom_headers)
            
            # Merge verification results into endpoint
            verified_count = verification['store_count']
            endpoint.update({
                'verified': verification['success'],
                'verified_store_count': verified_count,
                # Promote to store_count so downstream consumers (frontend, pattern_detector)
                # see a definitive count; only overwrite if verification actually returned data.
                'store_count': verified_count if verified_count else endpoint.get('store_count'),
                'verified_type': verification['detected_type'],
                'verified_is_region_specific': verification['is_region_specific'],
                'verification_error': verification.get('error'),
                'verification_time': verification['verification_time'],
                'sample_stores': verification.get('sample_stores', []),
                'data_path': verification.get('data_path', ''),
                'field_mapping': verification.get('field_mapping', {})
            })
            
            # Update URL to optimized version if it was optimized
            if optimized_url != url:
                endpoint['url'] = optimized_url
            
            # Ensure indicators list exists
            if 'indicators' not in endpoint:
                endpoint['indicators'] = []
            
            # Update confidence based on verification
            if verification['success'] and verification.get('store_count', 0) > 0:
                current_confidence = endpoint.get('confidence', 0)
                endpoint['confidence'] = min(current_confidence + 0.2, 1.0)
                endpoint['indicators'].append(f"verified:{verification['store_count']}_stores")
                sc = verification['store_count'] or 0
                final_url = endpoint.get('url') or ''
                suspicious = _is_suspected_tracking_or_personalization_url(final_url)
                trusted = not (suspicious and sc < _MIN_STORES_TO_TRUST_SUSPICIOUS_HOST)
                if trusted and sc > best_trusted_verified_count:
                    best_trusted_verified_count = sc

            verified_endpoints.append(endpoint)
        
        # Re-sort after verification: prefer real locator APIs over beacons that happen to
        # embed a tiny "stores" array. Previously (verified, store_count, confidence) put
        # 2-store false positives above stronger unverified candidates.
        def _rank_after_verify(ep: Dict) -> tuple:
            url = ep.get('url') or ''
            sc = ep.get('verified_store_count') or 0
            conf = float(ep.get('confidence') or 0)
            verified_ok = bool(ep.get('verified')) and sc > 0
            suspicious = _is_suspected_tracking_or_personalization_url(url)
            junk_verified = verified_ok and suspicious and sc < _MIN_STORES_TO_TRUST_SUSPICIOUS_HOST
            if verified_ok and not junk_verified:
                group = 2
            elif not verified_ok:
                group = 1
            else:
                group = 0
            return (group, conf, sc)

        verified_endpoints.sort(key=_rank_after_verify, reverse=True)
        
        return verified_endpoints
    
    def clear_cache(self):
        """Clear verification cache"""
        self.verification_cache.clear()


def verify_endpoint(url: str, custom_headers: Dict = None) -> Dict[str, Any]:
    """
    Convenience function to quickly verify a single endpoint
    
    Args:
        url: Endpoint URL
        custom_headers: Optional custom headers
        
    Returns:
        Verification result dict
    """
    verifier = EndpointVerifier()
    return verifier.quick_verify(url, custom_headers)


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description='Verify an endpoint')
    parser.add_argument('--url', required=True, help='Endpoint URL to verify')
    parser.add_argument('--headers', help='Custom headers as JSON string')
    
    args = parser.parse_args()
    
    custom_headers = None
    if args.headers:
        import json
        custom_headers = json.loads(args.headers)
    
    result = verify_endpoint(args.url, custom_headers)
    
    print("\n" + "=" * 80)
    print("ENDPOINT VERIFICATION RESULT")
    print("=" * 80)
    print()
    
    if result['success']:
        print(f"✅ SUCCESS")
        print(f"   Store Count: {result['store_count']}")
        print(f"   Type: {result['detected_type']}")
        print(f"   Region-Specific: {result['is_region_specific']}")
        if result.get('data_path'):
            print(f"   Data Path: {result['data_path']}")
        if result.get('sample_stores'):
            print(f"   Sample Stores: {len(result['sample_stores'])} preview")
        print(f"   Verification Time: {result['verification_time']:.2f}s")
    else:
        print(f"❌ FAILED")
        if result.get('error'):
            print(f"   Error: {result['error']}")
    
    print()
