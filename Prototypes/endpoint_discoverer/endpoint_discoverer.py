#!/usr/bin/env python3
"""Discovers API endpoints from store locator pages via Selenium network monitoring."""

import argparse
import concurrent.futures
import json
import re
import time
from typing import Dict, List, Optional, Any
from urllib.parse import urlparse, parse_qs, urlencode
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup
import requests

import sys
import os

_current_file_dir = os.path.dirname(os.path.abspath(__file__))
if _current_file_dir not in sys.path:
    sys.path.insert(0, _current_file_dir)

_parent_dir = os.path.dirname(_current_file_dir)
_data_scrappers_dir = os.path.join(_parent_dir, 'Data_Scrappers')
if _data_scrappers_dir not in sys.path:
    sys.path.insert(1, _data_scrappers_dir)

from network_analyzer import NetworkAnalyzer
from pattern_detector import PatternDetector

try:
    from endpoint_verifier import EndpointVerifier
    VERIFIER_AVAILABLE = True
except ImportError as e:
    VERIFIER_AVAILABLE = False
    EndpointVerifier = None
    _verifier_import_error = str(e)


# Known viewport API paths to probe on related brand domains.
# Ordered from most-specific to most-generic so we stop early on a hit.
_STORE_API_PROBE_PATHS = [
    '/app/establishments/by_viewport/light',
    '/app/establishments/by_viewport',
    '/api/v1/establishments/by_viewport',
    '/api/stores/by_viewport',
    '/api/locations/by_viewport',
    '/api/stores/viewport',
    '/api/v1/stores',
    '/api/v2/stores',
    '/api/stores',
    '/api/locations',
    '/api/retailers',
    '/api/establishments',
]

# Small European viewport used for probing — cheap, ~100–400 results for most brands.
_VIEWPORT_PROBE_PARAMS = {
    'northEastLat': '55.0',
    'northEastLng': '15.0',
    'southWestLat': '45.0',
    'southWestLng': '-5.0',
}


class EndpointDiscoverer:
    def __init__(self, headless: bool = True, timeout: int = 30, verify_endpoints: bool = True):
        self.headless = headless
        self.timeout = timeout
        self.driver = None
        self.network_analyzer = NetworkAnalyzer()
        self.pattern_detector = PatternDetector()
        self.verify_endpoints = verify_endpoints and VERIFIER_AVAILABLE
        if self.verify_endpoints:
            self.verifier = EndpointVerifier(cache_results=True)
        else:
            self.verifier = None
            if verify_endpoints and not VERIFIER_AVAILABLE:
                error_msg = globals().get('_verifier_import_error', 'scraping methods not found')
                print(f"  ⚠️  Endpoint verifier not available: {error_msg}")
        
    def _setup_driver(self):
        """Setup Selenium Chrome driver with network logging"""
        chrome_options = Options()
        
        # Try to find Chrome/Chromium binary
        import shutil
        chrome_binary = None
        for binary_name in ['chromium-browser', 'chromium', 'google-chrome', 'chrome']:
            binary_path = shutil.which(binary_name)
            if binary_path:
                chrome_binary = binary_path
                print(f"  Found browser: {binary_path}")
                break
        
        if chrome_binary:
            chrome_options.binary_location = chrome_binary
        
        if self.headless:
            chrome_options.add_argument('--headless=new')  # Use new headless mode
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--disable-gpu')
        chrome_options.add_argument('--window-size=1920,1080')
        chrome_options.add_argument('--disable-software-rasterizer')
        chrome_options.add_argument('--disable-extensions')
        chrome_options.add_argument('--disable-setuid-sandbox')
        chrome_options.add_argument('--disable-background-timer-throttling')
        chrome_options.add_argument('--disable-backgrounding-occluded-windows')
        chrome_options.add_argument('--disable-renderer-backgrounding')
        chrome_options.add_argument('--disable-blink-features=AutomationControlled')
        chrome_options.add_experimental_option('excludeSwitches', ['enable-automation'])
        chrome_options.add_experimental_option('useAutomationExtension', False)
        # Grant geolocation without a permission prompt so map-based store locators
        # (e.g. SFCC/Demandware) fire their API calls in headless mode.
        chrome_options.add_argument('--use-fake-ui-for-media-stream')
        chrome_options.add_experimental_option('prefs', {
            'profile.default_content_setting_values.geolocation': 1,  # 1 = allow
        })
        
        # Enable performance logging to capture network requests
        chrome_options.set_capability('goog:loggingPrefs', {'performance': 'ALL'})
        chrome_options.set_capability('goog:chromeOptions', {
            'perfLoggingPrefs': {
                'enableNetwork': True,
                'enablePage': True
            }
        })
        
        try:
            # Try to use system chromedriver first (matches installed Chromium)
            system_chromedriver = None
            for chromedriver_name in ['chromium-chromedriver', 'chromedriver']:
                chromedriver_path = shutil.which(chromedriver_name)
                if chromedriver_path:
                    system_chromedriver = chromedriver_path
                    print(f"  ✓ Found system ChromeDriver: {system_chromedriver}")
                    break
            
            if system_chromedriver:
                # Use system chromedriver
                service = Service(system_chromedriver)
                self.driver = webdriver.Chrome(service=service, options=chrome_options)
            else:
                # Fall back to webdriver-manager
                print("  ⚠️  System ChromeDriver not found, using webdriver-manager...")
                try:
                    driver_path = ChromeDriverManager().install()
                    print(f"  ✓ Using ChromeDriver: {driver_path}")
                    service = Service(driver_path)
                    self.driver = webdriver.Chrome(service=service, options=chrome_options)
                except Exception as wdm_error:
                    print(f"  ⚠️  webdriver-manager failed: {wdm_error}")
                    raise Exception(
                        f"Failed to setup ChromeDriver.\n"
                        f"Please install: sudo apt-get install chromium-chromedriver\n"
                        f"Or download from: https://chromedriver.chromium.org/"
                    )
            
            # Enable CDP (Chrome DevTools Protocol) for better network capture
            try:
                self.driver.execute_cdp_cmd('Network.enable', {})
                print("  ✓ Enabled Chrome DevTools Protocol network monitoring")
            except Exception as cdp_error:
                print(f"  ⚠️  CDP not available (may still work): {cdp_error}")

            # Mock geolocation so map-based store locators (e.g. SFCC) fire API calls.
            # Without this, headless Chrome has no location and the map stays blank.
            try:
                self.driver.execute_cdp_cmd('Emulation.setGeolocationOverride', {
                    'latitude': 40.7128,    # New York City
                    'longitude': -74.0060,
                    'accuracy': 100,
                })
                print("  ✓ Mocked geolocation to New York City (40.71°N, 74.00°W)")
            except Exception as geo_error:
                print(f"  ⚠️  Could not mock geolocation: {geo_error}")
            
            self.driver.set_page_load_timeout(self.timeout)
            print("  ✓ Driver setup complete")
            
        except Exception as e:
            error_msg = str(e)
            print(f"  ❌ Driver setup error: {error_msg}")
            
            # Provide helpful error messages
            if "version" in error_msg.lower() or "chromedriver" in error_msg.lower():
                raise Exception(
                    f"ChromeDriver version mismatch or not found.\n"
                    f"Install with: sudo apt-get install chromium-chromedriver\n"
                    f"Or download matching version from: https://chromedriver.chromium.org/\n"
                    f"Original error: {e}"
                )
            elif not chrome_binary:
                raise Exception(
                    f"Chrome/Chromium browser not found.\n"
                    f"Install with: sudo apt-get install chromium-browser\n"
                    f"Original error: {e}"
                )
            else:
                raise Exception(f"Failed to setup Chrome driver: {e}")
        
    def _interact_with_page(self, url: str) -> List[str]:
        """
        Interact with the store locator page to trigger API calls.
        Returns list of URLs seen (including current URL after each interaction).
        
        Args:
            url: Store locator page URL
            
        Returns:
            List of URLs captured from page navigation (e.g. after filter selection)
        """
        seen_urls: List[str] = []
        
        def _capture_current_url():
            """Capture current URL if it has query params and differs from original"""
            try:
                current = self.driver.current_url
                if current and current not in seen_urls:
                    parsed = urlparse(current)
                    if parsed.query and self._is_relevant_request(current, 'text/html'):
                        seen_urls.append(current)
                        return current
            except Exception:
                pass
            return None
        
        print(f"  🌐 Loading page: {url}")
        try:
            self.driver.set_page_load_timeout(self.timeout)
            self.driver.get(url)
            print(f"  ✓ Page loaded")
        except Exception as e:
            # Check if it's a timeout error - these are common and OK
            error_str = str(e)
            if 'timeout' in error_str.lower() or 'timed out' in error_str.lower():
                print(f"  ⚠️  Page load timeout (page may have loaded partially - continuing)")
            else:
                print(f"  ⚠️  Page load warning: {error_str[:200]}")
            # Continue anyway - page might have loaded partially
        
        # Wait for page to fully load and JavaScript to execute.
        # Hash-routed map pages (e.g. #lat=...&lng=...) fire their SFCC API call during a
        # second render cycle triggered by the hash — give them extra time.
        parsed_initial = urlparse(url)
        has_map_hash = any(k in (parsed_initial.fragment or '').lower() for k in ('lat', 'lng', 'lon'))
        initial_wait = 6 if has_map_hash else 4
        print(f"  ⏳ Waiting {initial_wait}s for page to initialize...")
        time.sleep(initial_wait)
        
        # Try to wait for common store locator elements
        try:
            WebDriverWait(self.driver, 15).until(
                lambda d: d.execute_script('return document.readyState') == 'complete'
            )
            print(f"  ✓ Page ready")
        except Exception as e:
            # Timeout is OK - page might still have loaded, just continue
            print(f"  ⚠️  Page ready check timeout (continuing anyway)")
            # Don't print the full error stack trace for timeouts
        
        # Try common interactions that might trigger API calls
        interactions = [
            ("Map Interaction", self._try_map_interaction),
            ("Filter Dropdown", self._try_filter_dropdown),
            ("Load More", self._try_load_more),
        ]
        
        successful_interactions = 0
        for name, interaction in interactions:
            try:
                print(f"  🔍 Trying {name}...")
                if interaction():
                    successful_interactions += 1
                    print(f"  ✓ {name} triggered")
                    time.sleep(1)
                    captured = _capture_current_url()
                    if captured:
                        print(f"  ✓ Captured URL after {name}: {captured[:80]}...")
                else:
                    print(f"  ⊘ {name} not available")
                time.sleep(2)
            except Exception as e:
                print(f"  ⊘ {name} failed: {str(e)[:100]}")
                continue
        
        if successful_interactions == 0:
            print(f"  ⚠️  No interactions triggered - page may load data automatically")
        
        # Final capture of current URL
        _capture_current_url()
        
        # Final wait — map-heavy pages can be slow to resolve their first API call
        final_wait = 5 if has_map_hash else 3
        print(f"  ⏳ Final wait {final_wait}s for delayed requests...")
        time.sleep(final_wait)
        
        return seen_urls
    
    def _try_map_interaction(self):
        """Try to interact with map (pan, zoom)"""
        try:
            # Look for map container
            map_selectors = [
                "#map",
                ".map",
                "[data-map]",
                ".map-container",
                "#store-map",
                ".gmap",
                "[id*='map' i]",
                "[class*='map' i]"
            ]
            
            for selector in map_selectors:
                try:
                    map_elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    for map_element in map_elements:
                        try:
                            if map_element.is_displayed():
                                # Try to click on map to trigger viewport change
                                from selenium.webdriver.common.action_chains import ActionChains
                                actions = ActionChains(self.driver)
                                
                                # Move to center and click
                                actions.move_to_element(map_element).move_by_offset(10, 10).click().perform()
                                time.sleep(0.5)
                                
                                # Try dragging to trigger pan
                                actions.move_to_element(map_element).click_and_hold().move_by_offset(50, 50).release().perform()
                                
                                return True
                        except:
                            continue
                except:
                    continue
        except Exception as e:
            pass
        
        return False
    
    def _try_filter_dropdown(self):
        """Try to change filters/dropdowns (native select and custom UI)"""
        try:
            # 1. Native HTML select elements
            dropdown_selectors = [
                "select[name*='country' i]",
                "select[name*='region' i]",
                "select[name*='state' i]",
                "select[id*='country' i]",
                "select[id*='region' i]",
                "[data-country]",
                "[data-region]"
            ]
            
            for selector in dropdown_selectors:
                try:
                    dropdowns = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    for dropdown in dropdowns:
                        try:
                            if dropdown.is_displayed():
                                from selenium.webdriver.support.ui import Select
                                select = Select(dropdown)
                                if len(select.options) > 1:
                                    current_index = 0
                                    for i, option in enumerate(select.options):
                                        if option.is_selected():
                                            current_index = i
                                            break
                                    next_index = (current_index + 1) % len(select.options)
                                    select.select_by_index(next_index)
                                    return True
                        except Exception:
                            continue
                except Exception:
                    continue
            
            # 2. Custom UI: clickable elements with country/region text
            country_phrases = [
                'united states', 'usa', 'us ', ' u.s.', 'united kingdom', 'uk ',
                'select country', 'choose country', 'all countries'
            ]
            clickable_selectors = [
                "button", "a", "[role='option']", "[role='menuitem']",
                "[data-value]", "[data-country]", "li", ".dropdown-item",
                ".country-option", "[class*='country']", "[class*='region']"
            ]
            for selector in clickable_selectors:
                try:
                    elements = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    for el in elements:
                        try:
                            if not el.is_displayed() or not el.is_enabled():
                                continue
                            text = (el.text or el.get_attribute('aria-label') or '').lower()
                            if any(phrase in text for phrase in country_phrases):
                                el.click()
                                return True
                        except Exception:
                            continue
                except Exception:
                    continue
        except Exception:
            pass
        
        return False
    
    def _try_load_more(self):
        """Try to click 'Load More' or pagination"""
        try:
            # Try to find buttons by text content (more reliable)
            try:
                buttons = self.driver.find_elements(By.TAG_NAME, "button")
                for button in buttons:
                    try:
                        text = button.text.lower()
                        if any(phrase in text for phrase in ['load more', 'show more', 'view more', 'next']):
                            if button.is_displayed() and button.is_enabled():
                                button.click()
                                return True
                    except:
                        continue
            except:
                pass
            
            # Try CSS selectors
            load_more_selectors = [
                ".load-more",
                "[data-load-more]",
                ".pagination a",
                ".next-page",
                "a[aria-label*='next' i]",
                "button[aria-label*='more' i]"
            ]
            
            for selector in load_more_selectors:
                try:
                    buttons = self.driver.find_elements(By.CSS_SELECTOR, selector)
                    for button in buttons:
                        try:
                            if button.is_displayed() and button.is_enabled():
                                button.click()
                                return True
                        except:
                            continue
                except:
                    continue
        except Exception as e:
            pass
        
        return False
    
    def _capture_network_requests(self) -> List[Dict]:
        """
        Capture network requests from browser logs using both CDP and performance logs
        
        Returns:
            List of network request dictionaries
        """
        requests = []
        seen_urls = set()  # Deduplicate
        
        # Method 1: Try CDP (Chrome DevTools Protocol) - more reliable
        try:
            # Get network events from CDP
            network_events = self.driver.execute_cdp_cmd('Network.getResponseBody', {})
            # Note: CDP doesn't directly give us all requests, so we'll use performance logs
        except:
            pass  # CDP might not be available
        
        # Method 2: Use performance logs (more compatible)
        try:
            logs = self.driver.get_log('performance')
            print(f"  📡 Captured {len(logs)} performance log entries")
            
            for log in logs:
                try:
                    message = json.loads(log['message'])
                    msg_data = message.get('message', {})
                    method = msg_data.get('method', '')
                    params = msg_data.get('params', {})
                    
                    # Capture response received events
                    if method == 'Network.responseReceived':
                        response = params.get('response', {})
                        url = response.get('url', '')
                        mime_type = response.get('mimeType', '')
                        
                        if url and url not in seen_urls:
                            seen_urls.add(url)
                            
                            # Filter for relevant requests
                            if self._is_relevant_request(url, mime_type):
                                requests.append({
                                    'url': url,
                                    'method': response.get('method', 'GET'),
                                    'status': response.get('status', 0),
                                    'mimeType': mime_type,
                                    'headers': response.get('headers', {})
                                })
                    
                    # Also capture request will be sent (to get request headers)
                    elif method == 'Network.requestWillBeSent':
                        request_data = params.get('request', {})
                        url = request_data.get('url', '')
                        if url and url not in seen_urls:
                            # Check if we already have this URL from response
                            if not any(r['url'] == url for r in requests):
                                if self._is_relevant_request(url, ''):
                                    requests.append({
                                        'url': url,
                                        'method': request_data.get('method', 'GET'),
                                        'status': 0,  # Request hasn't completed yet
                                        'mimeType': '',
                                        'headers': request_data.get('headers', {})
                                    })
                                    seen_urls.add(url)
                                    
                except (json.JSONDecodeError, KeyError, TypeError) as e:
                    continue  # Skip malformed log entries
                    
        except Exception as e:
            print(f"  ⚠️  Warning: Could not capture network logs: {e}")
            import traceback
            traceback.print_exc()
        
        print(f"  ✓ Found {len(requests)} relevant network requests")
        return requests

    def _capture_performance_api_requests(self, seen_urls: set) -> List[Dict]:
        """
        Use window.performance.getEntriesByType('resource') to collect ALL network
        requests the browser recorded since page load — including those that fired
        before CDP logging started (common on map-heavy, hash-routed pages like SFCC).

        Args:
            seen_urls: Set of already-collected URLs (mutated in place to deduplicate).

        Returns:
            List of new request dicts not already in seen_urls.
        """
        if not self.driver:
            return []
        try:
            entries = self.driver.execute_script(
                "return window.performance.getEntriesByType('resource').map(function(e){"
                "return {url: e.name, initiatorType: e.initiatorType};});"
            ) or []
        except Exception:
            return []

        new_requests: List[Dict] = []
        for entry in entries:
            url = (entry.get('url') or '').strip()
            if not url or url in seen_urls:
                continue
            if not self._is_relevant_request(url, ''):
                continue
            seen_urls.add(url)
            initiator = entry.get('initiatorType', '')
            new_requests.append({
                'url': url,
                'method': 'GET',
                'status': 0,
                'mimeType': 'application/json' if 'fetch' in initiator or 'xmlhttprequest' in initiator else '',
                'headers': {},
            })

        if new_requests:
            print(f"  ✓ Performance API found {len(new_requests)} additional request(s) not in CDP logs")
        return new_requests

    def _is_relevant_request(self, url: str, mime_type: str) -> bool:
        """Check if a network request is relevant for store locator discovery"""
        if not url:
            return False
        
        url_lower = url.lower()
        
        # Skip static assets
        skip_extensions = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', 
                          '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webp']
        if any(url_lower.endswith(ext) for ext in skip_extensions):
            return False
        
        # Skip tracking/analytics and Google Maps API libraries
        skip_domains = ['google-analytics', 'googletagmanager', 'facebook', 'twitter',
                       'linkedin', 'pinterest', 'analytics', 'tracking', 'ads', 'advertising',
                       'fonts.googleapis', 'fonts.gstatic', 'cdn', 'static',
                       'contentsquare', 'c.contentsquare.net',
                       'cquotient.com', 'e.cquotient.com', 'p.cquotient.com']
        if any(domain in url_lower for domain in skip_domains):
            return False
        
        # Skip Google Maps API endpoints (they're JavaScript libraries, not store data)
        if 'maps.googleapis.com' in url_lower:
            if '/api/js' in url_lower or '/api/place' in url_lower or '/maps/vt' in url_lower:
                return False

        # SFCC site URLs use hostname/path "demandware.store" — substring contains "store" but
        # ServiceWorker-Manifest, site prefs, etc. are not store APIs (real JSON is under /dw/shop/).
        if 'demandware.store' in url_lower and '/dw/shop/' not in url_lower:
            return False
        if 'serviceworker' in url_lower or 'service-worker' in url_lower:
            return False
        if url_lower.rstrip('/').endswith('-manifest') or '/manifest' in url_lower and 'stores' not in url_lower:
            return False
        
        # Look for relevant indicators
        relevant_keywords = ['api', 'json', 'store', 'location', 'retailer', 'establishment',
                           'point', 'dealer', 'boutique', 'locator', 'search', 'find']
        # Salesforce Commerce Cloud (Demandware) JSON store search
        if '/dw/shop/' in url_lower and '/stores' in url_lower:
            return True
        
        # Check URL
        if any(keyword in url_lower for keyword in relevant_keywords):
            return True
        
        # Check MIME type
        if mime_type:
            if 'json' in mime_type.lower():
                return True
            if 'html' in mime_type.lower() and any(kw in url_lower for kw in ['store', 'location', 'locator']):
                return True
        
        return False

    def _extract_sfcc_store_api_urls_from_page(self) -> List[Dict]:
        """
        Pull SFCC / Demandware store search URLs from rendered page source.
        These often call api.<brand>.<tld>/s/.../dw/shop/vXX_XX/stores?client_id=... and may
        be missed when performance logs truncate or the map loads late (hash routing).

        Also tries to attach a discovered client_id to the base URL so the verifier
        can make a real test request.
        """
        if not self.driver:
            return []
        try:
            source = self.driver.page_source or ''
        except Exception:
            return []

        # Escaped URLs in JSON strings: https:\/\/api...
        norm = source.replace('\\/', '/')

        # Collect SFCC base URLs (path-only, no query string yet)
        base_found: List[str] = []
        for m in re.finditer(
            r'(https?://[a-zA-Z0-9.-]+/s/[^/\s"\'<>]+/dw/shop/v\d+_\d+/stores)',
            norm,
            re.IGNORECASE,
        ):
            u = m.group(1).rstrip('.,;)\'"')
            if u not in base_found:
                base_found.append(u)

        # Also capture full URLs that already include a query string (client_id may be inline)
        full_found: dict[str, str] = {}  # base_url -> full_url_with_qs
        for m in re.finditer(
            r'(https?://[a-zA-Z0-9.-]+/s/[^/\s"\'<>]+/dw/shop/v\d+_\d+/stores'
            r'\?[^\s"\'<>]{10,})',
            norm,
            re.IGNORECASE,
        ):
            u = m.group(1).rstrip('.,;)\'"')
            parsed = urlparse(u)
            base = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            if base not in full_found:
                full_found[base] = u

        # Try to find a client_id anywhere in the page source (UUID or long hex string)
        client_id_match = re.search(
            r'client[_-]?id["\s]*[:=]["\s]*([0-9a-f-]{20,})',
            norm,
            re.IGNORECASE,
        )
        client_id = client_id_match.group(1).strip('"\'') if client_id_match else None

        out: List[Dict] = []
        seen_bases = set()
        for base_url in base_found:
            if base_url in seen_bases:
                continue
            seen_bases.add(base_url)
            # Prefer a full URL with query string if we already found one
            if base_url in full_found:
                url = full_found[base_url]
            elif client_id:
                url = f"{base_url}?client_id={client_id}"
                print(f"  ✓ Attached client_id={client_id[:8]}... to SFCC URL")
            else:
                url = base_url
            out.append({
                'url': url,
                'method': 'GET',
                'status': 0,
                'mimeType': 'application/json',
                'headers': {'Accept': 'application/json'},
            })

        if out:
            print(f"  ✓ Extracted {len(out)} SFCC /dw/shop/.../stores URL(s) from page source")
        return out
    
    def _analyze_html_content(self, url: str) -> Optional[Dict]:
        """
        Analyze HTML content for embedded store data
        
        Args:
            url: URL to analyze
            
        Returns:
            Dictionary with detected HTML patterns or None
        """
        try:
            response = requests.get(url, timeout=15, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            html = response.text
            
            # Quick check: does HTML contain store-related patterns?
            store_patterns = [
                r'"stores?"\s*:\s*\[',
                r'"locations?"\s*:\s*\[',
                r'"points?"\s*:\s*\[',
                r'"establishments?"\s*:\s*\[',
                r'"retailers?"\s*:\s*\[',
                r'data-lat.*data-lng',
                r'latitude.*longitude',
                r'store.*locator',
                r'points?.*sale',
            ]
            pattern_matches = sum(1 for pattern in store_patterns if re.search(pattern, html, re.IGNORECASE))
            
            if pattern_matches == 0:
                return None  # No store data patterns found
            
            soup = BeautifulSoup(html, 'html.parser')
            
            # Look for embedded JSON data in script tags
            script_tags = soup.find_all('script', type=lambda x: x and ('json' in x.lower() or x == 'application/json'))
            script_tags.extend(soup.find_all('script', string=re.compile(r'\{.*"(?:stores?|locations?|points?|establishments?|retailers?)".*\}', re.DOTALL | re.IGNORECASE)))
            
            store_count_estimate = 0
            
            for script in script_tags:
                script_content = script.string if script.string else ''
                
                # Try to find JSON data
                json_matches = re.findall(r'\{[^{}]*(?:"stores?"|"locations?"|"points?"|"establishments?"|"retailers?").*?\}', script_content, re.DOTALL | re.IGNORECASE)
                
                for match in json_matches:
                    try:
                        data = json.loads(match)
                        if self._has_store_data(data):
                            # Count stores in the data
                            if isinstance(data, dict):
                                for key, value in data.items():
                                    if isinstance(value, list) and len(value) > 0:
                                        store_count_estimate = max(store_count_estimate, len(value))
                            elif isinstance(data, list):
                                store_count_estimate = max(store_count_estimate, len(data))
                            
                            return {
                                'type': 'html',
                                'source': 'embedded_json',
                                'data': data,
                                'detected_in': 'script_tag',
                                'store_count_estimate': store_count_estimate,
                                'pattern_matches': pattern_matches
                            }
                    except:
                        continue
            
            # Look for data attributes
            store_elements = soup.find_all(attrs={'data-lat': True, 'data-lng': True})
            if store_elements:
                return {
                    'type': 'html',
                    'source': 'data_attributes',
                    'elements_found': len(store_elements),
                    'sample_element': str(store_elements[0])[:200] if store_elements else None,
                    'store_count_estimate': len(store_elements),
                    'pattern_matches': pattern_matches
                }
            
            # If we found patterns but no structured data, still return indication
            if pattern_matches >= 2:
                return {
                    'type': 'html',
                    'source': 'pattern_match',
                    'pattern_matches': pattern_matches,
                    'store_count_estimate': None  # Can't determine without parsing
                }
            
        except Exception as e:
            print(f"  Warning: HTML analysis failed: {e}")
        
        return None
    
    def _try_proactive_url_variations(self, store_locator_url: str) -> List[Dict]:
        """
        Try common query param combinations on store locator URL.
        Catches cases like Bulgari where data requires ?country-region=US&per=50&offset=0.
        
        Returns:
            List of request dicts for URLs that return store data
        """
        from urllib.parse import urlparse, urlunparse
        
        results = []
        parsed = urlparse(store_locator_url)
        base_path = parsed.path.rstrip('/') or '/'
        base_scheme = parsed.scheme or 'https'
        base_netloc = parsed.netloc
        
        # Common param combinations for store locators
        param_sets = [
            {'country-region': 'US', 'l': 'en_US', 'per': '50', 'offset': '0'},
            {'country-region': 'US', 'per': '50', 'offset': '0'},
            {'country': 'US', 'per': '50', 'offset': '0'},
            {'country': 'US', 'per_page': '50', 'offset': '0'},
            {'region': 'US', 'per': '50', 'offset': '0'},
            {'per': '50', 'offset': '0'},
        ]
        
        for params in param_sets:
            query = urlencode(params)
            url = f"{base_scheme}://{base_netloc}{base_path}?{query}"
            try:
                response = requests.get(url, timeout=10, headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html, application/json, */*'
                })
                if response.status_code != 200:
                    continue
                content_type = response.headers.get('content-type', '').lower()
                html = response.text if 'html' in content_type else ''
                try:
                    data = response.json() if 'json' in content_type else None
                except Exception:
                    data = None
                
                # Check for store data in HTML or JSON
                has_store_data = False
                if html:
                    store_patterns = [
                        r'"stores?"\s*:\s*\[', r'"locations?"\s*:\s*\[',
                        r'data-lat.*data-lng', r'latitude.*longitude',
                    ]
                    has_store_data = any(re.search(p, html, re.IGNORECASE) for p in store_patterns)
                if data and not has_store_data:
                    has_store_data = self._has_store_data(data)
                
                if has_store_data:
                    results.append({
                        'url': url,
                        'method': 'GET',
                        'status': 200,
                        'mimeType': content_type or 'text/html',
                        'headers': {}
                    })
                    print(f"  ✓ Proactive variation has store data: {url[:80]}...")
                    break  # One working variant is enough
            except Exception:
                continue
        
        return results
    
    def _probe_related_api_domains(self, store_locator_url: str) -> List[Dict]:
        """
        Find related brand subdomains mentioned in the rendered page and probe them
        with known store-API path patterns.

        This handles cases like Rolex where the store locator lives on
        www.rolex.com but the actual API is on retailers.rolex.com.
        Probes all (domain, path) combinations concurrently.
        """
        if not self.driver:
            return []

        try:
            source = self.driver.page_source
        except Exception:
            return []

        parsed_base = urlparse(store_locator_url)
        base_parts = parsed_base.netloc.split('.')
        if len(base_parts) < 2:
            return []
        brand_tld = '.'.join(base_parts[-2:])   # e.g. "rolex.com"

        # Extract all quoted https URLs from the rendered source
        raw_urls = re.findall(r'"(https?://[a-zA-Z0-9.-]+)"', source)
        related_domains: set = set()
        for raw in raw_urls:
            p = urlparse(raw)
            if (p.netloc
                    and p.netloc != parsed_base.netloc
                    and brand_tld in p.netloc):
                related_domains.add(f"{p.scheme}://{p.netloc}")

        # Skip domains that are clearly CDN/media/tracking, not API servers
        _NON_API_SUBDOMAIN_PREFIXES = {
            'static', 'media', 'assets', 'asset', 'cdn', 'img', 'images',
            'fonts', 'content', 'files', 'metrics', 'analytics', 'tracking',
            'mail', 'email', 'smtp',
        }
        related_domains = {
            d for d in related_domains
            if urlparse(d).hostname.split('.')[0].lower() not in _NON_API_SUBDOMAIN_PREFIXES
        }

        if not related_domains:
            return []

        print(f"  🔎 Probing {len(related_domains)} related brand domain(s): {', '.join(related_domains)}")

        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

        # Track first successful hit per domain so we only return one result per domain
        domain_hits: Dict[str, Dict] = {}

        def _probe(domain: str, path: str) -> Optional[Dict]:
            probe_url = f"{domain}{path}"
            try:
                resp = requests.get(
                    probe_url,
                    params=_VIEWPORT_PROBE_PARAMS,
                    headers=headers,
                    timeout=8,
                )
                if resp.status_code != 200:
                    return None
                ct = resp.headers.get('content-type', '').lower()
                if 'json' not in ct:
                    return None
                data = resp.json()
                is_store_list = isinstance(data, list) and len(data) > 0
                is_store_dict = isinstance(data, dict) and self._has_store_data(data)
                if is_store_list or is_store_dict:
                    return {
                        'domain': domain,
                        'url': resp.url,
                        'method': 'GET',
                        'status': 200,
                        'mimeType': ct,
                        'headers': {},
                    }
            except Exception:
                pass
            return None

        # Build all (domain, path) tasks; _STORE_API_PROBE_PATHS is ordered most→least specific
        tasks = [(domain, path) for domain in related_domains for path in _STORE_API_PROBE_PATHS]

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(len(tasks), 16)) as executor:
            futures = {executor.submit(_probe, domain, path): (domain, path) for domain, path in tasks}
            for future in concurrent.futures.as_completed(futures):
                hit = future.result()
                if hit:
                    domain = hit.pop('domain')
                    if domain not in domain_hits:
                        domain_hits[domain] = hit
                        print(f"  ✓ Found store API on related domain: {hit['url'][:80]}")

        return list(domain_hits.values())

    def _has_store_data(self, data: Any, depth: int = 0) -> bool:
        """
        Check if data structure contains store location data
        
        Args:
            data: Data to check
            depth: Recursion depth
            
        Returns:
            True if store data is detected
        """
        if depth > 5:  # Limit recursion
            return False
        
        if isinstance(data, dict):
            # Check for store-related keys
            store_keys = ['store', 'location', 'retailer', 'establishment', 'point', 'dealer', 'boutique']
            data_keys = ' '.join(str(k).lower() for k in data.keys())
            
            # Check for required fields
            required_fields = ['address', 'lat', 'lng', 'latitude', 'longitude', 'city', 'name']
            found_fields = sum(1 for field in required_fields if field in data_keys)
            
            # If we have store-related keys and multiple required fields, it's likely store data
            if any(key in data_keys for key in store_keys) and found_fields >= 2:
                return True
            
            # Recursively check nested structures
            for value in data.values():
                if self._has_store_data(value, depth + 1):
                    return True
        
        elif isinstance(data, list):
            # Check if list contains store-like objects
            if len(data) > 0:
                sample = data[0]
                if isinstance(sample, dict):
                    return self._has_store_data(sample, depth + 1)
        
        return False
    
    def discover(self, store_locator_url: str) -> Dict[str, Any]:
        """
        Discover API endpoint from store locator page
        
        Args:
            store_locator_url: URL of the store locator page
            
        Returns:
            Dictionary with discovered endpoint information
        """
        result = {
            'success': False,
            'url': store_locator_url,
            'endpoints': [],
            'suggested_config': None,
            'errors': []
        }
        
        try:
            self._setup_driver()
            print(f"\n{'='*80}")
            print(f"Discovering endpoints from: {store_locator_url}")
            print(f"{'='*80}\n")
            
            # Interact with page to trigger API calls
            navigation_urls = self._interact_with_page(store_locator_url)
            
            # Capture network requests via CDP performance logs
            print("\n📡 Capturing network requests...")
            network_requests = self._capture_network_requests()

            # Supplement with window.performance entries — catches requests that fired
            # before CDP was ready (e.g. SFCC map call on hash-routed pages).
            cdp_seen = {r['url'] for r in network_requests}
            perf_requests = self._capture_performance_api_requests(cdp_seen)
            network_requests.extend(perf_requests)

            # Add URLs captured from page navigation (e.g. after filter selection)
            for nav_url in navigation_urls:
                if not any(r.get('url') == nav_url for r in network_requests):
                    network_requests.append({
                        'url': nav_url,
                        'method': 'GET',
                        'status': 200,
                        'mimeType': 'text/html',
                        'headers': {}
                    })
                    print(f"  ✓ Added URL from page navigation: {nav_url[:80]}...")
            
            # Proactive URL variation testing (e.g. Bulgari: ?country-region=US&per=50&offset=0)
            print("\n🔬 Trying proactive URL variations...")
            proactive_requests = self._try_proactive_url_variations(store_locator_url)
            for req in proactive_requests:
                if not any(r.get('url') == req['url'] for r in network_requests):
                    network_requests.append(req)

            # Probe related brand subdomains found in the rendered page source.
            # Handles cases like Rolex (www.rolex.com page, retailers.rolex.com API).
            print("\n🔎 Probing related brand domains from page config...")
            related_domain_requests = self._probe_related_api_domains(store_locator_url)
            for req in related_domain_requests:
                if not any(r.get('url') == req['url'] for r in network_requests):
                    network_requests.append(req)

            # SFCC store locator: API URL is often embedded in JS (api.* + /dw/shop/v.../stores)
            print("\n📎 Scanning page source for SFCC store API URLs...")
            for req in self._extract_sfcc_store_api_urls_from_page():
                if not any(r.get('url') == req['url'] for r in network_requests):
                    network_requests.append(req)

            if len(network_requests) == 0:
                print(f"  ⚠️  No network requests captured - trying alternative method...")
                # Try capturing from page source or checking if data is embedded
                time.sleep(2)
                network_requests = self._capture_network_requests()
            
            print(f"  Found {len(network_requests)} potential API requests")
            
            # Analyze HTML content for embedded data FIRST (before network analysis)
            # This helps us identify HTML pages with store data
            print("\n📄 Analyzing HTML content...")
            html_analysis = self._analyze_html_content(store_locator_url)
            if html_analysis:
                result['html_analysis'] = html_analysis
                if html_analysis.get('store_count_estimate'):
                    print(f"  ✓ Found embedded store data: ~{html_analysis.get('store_count_estimate')} stores")
                elif html_analysis.get('pattern_matches'):
                    print(f"  ✓ Found store data patterns: {html_analysis.get('pattern_matches')} matches")
            
            # Analyze network requests
            print("\n🔍 Analyzing network requests...")
            analyzed_endpoints = self.network_analyzer.analyze_requests(network_requests, store_locator_url)
            
            # Boost confidence for HTML endpoints that match the store locator URL and have store data
            if html_analysis and (html_analysis.get('store_count_estimate') or html_analysis.get('pattern_matches', 0) >= 2):
                for endpoint in analyzed_endpoints:
                    # If this endpoint is the HTML page itself and has store data
                    if endpoint.get('type') == 'html' and endpoint.get('url') == store_locator_url:
                        # Significantly boost confidence
                        endpoint['confidence'] = min(endpoint.get('confidence', 0) + 0.4, 1.0)
                        if html_analysis.get('store_count_estimate'):
                            endpoint['store_count'] = html_analysis.get('store_count_estimate')
                        endpoint['indicators'].append('html_with_embedded_store_data')
                        print(f"  ✓ Boosted confidence for HTML endpoint with embedded store data")
                
                # Re-sort endpoints by confidence after boosting
                analyzed_endpoints.sort(key=lambda x: (x.get('confidence', 0), x.get('store_count', 0) or 0), reverse=True)
            
            # Show which endpoints had base URL variations found
            for endpoint in analyzed_endpoints:
                if endpoint.get('is_base_url'):
                    print(f"  ✓ Found base URL for: {endpoint.get('url', '')[:80]}...")
                    if endpoint.get('original_url'):
                        print(f"    (removed location params from: {endpoint.get('original_url', '')[:80]}...)")
            
            # Verify endpoints using existing scraping methods (if enabled)
            # Do this BEFORE pattern detection so pattern detector can use verified data
            if self.verify_endpoints and self.verifier and analyzed_endpoints:
                print("\n🔬 Verifying endpoints with scraping methods...")
                print(f"   Testing {len(analyzed_endpoints)} endpoints...")
                
                try:
                    verified_endpoints = self.verifier.verify_multiple(analyzed_endpoints)
                    
                    # Show verification results
                    verified_count = sum(1 for ep in verified_endpoints if ep.get('verified'))
                    print(f"   ✓ Verified {verified_count}/{len(verified_endpoints)} endpoints")
                    for endpoint in verified_endpoints[:5]:  # Show top 5
                        if endpoint.get('verified'):
                            store_count = endpoint.get('verified_store_count', 0)
                            url_display = endpoint.get('optimized_url') or endpoint.get('url', '')
                            if endpoint.get('optimized_url'):
                                print(f"      • {url_display[:60]}... → {store_count} stores (optimized radius) ({endpoint.get('verification_time', 0):.2f}s)")
                            else:
                                print(f"      • {url_display[:60]}... → {store_count} stores ({endpoint.get('verification_time', 0):.2f}s)")
                        elif endpoint.get('verification_error'):
                            error_msg = endpoint.get('verification_error', '')
                            print(f"      ⊘ {endpoint.get('url', '')[:60]}... → {error_msg[:80]}")
                    
                    analyzed_endpoints = verified_endpoints
                except Exception as e:
                    print(f"   ⚠️  Verification failed: {e}")
                    import traceback
                    traceback.print_exc()
            elif self.verify_endpoints and not self.verifier:
                print("\n⚠️  Endpoint verification skipped (verifier not available)")
            
            result['endpoints'] = analyzed_endpoints
            
            # Detect patterns and suggest configuration
            # Use verified endpoints if available (they have better data)
            print("\n🎯 Detecting endpoint patterns...")
            suggested_config = self.pattern_detector.detect_and_suggest(
                analyzed_endpoints,
                html_analysis,
                store_locator_url
            )
            result['suggested_config'] = suggested_config
            
            result['success'] = True
            
        except Exception as e:
            result['errors'].append(str(e))
            print(f"\n❌ Error: {e}")
        
        finally:
            if self.driver:
                self.driver.quit()
        
        return result


def main():
    """Command line interface"""
    parser = argparse.ArgumentParser(
        description='Discover API endpoints from store locator pages',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument('--url', required=True, help='Store locator page URL')
    parser.add_argument('--headless', action='store_true', default=True, help='Run browser in headless mode')
    parser.add_argument('--output', help='Output file for results (JSON)')
    parser.add_argument('--no-verify', action='store_true', help='Skip endpoint verification (faster but less accurate)')
    
    args = parser.parse_args()
    
    discoverer = EndpointDiscoverer(headless=args.headless, verify_endpoints=not args.no_verify)
    result = discoverer.discover(args.url)
    
    # Print results
    print(f"\n{'='*80}")
    print("DISCOVERY RESULTS")
    print(f"{'='*80}\n")
    
    if result['success']:
        print(f"✅ Successfully analyzed: {args.url}\n")
        
        if result['endpoints']:
            print(f"Found {len(result['endpoints'])} potential endpoints:\n")
            for i, endpoint in enumerate(result['endpoints'], 1):
                print(f"{i}. {endpoint.get('url', 'Unknown')}")
                print(f"   Type: {endpoint.get('type', 'unknown')}")
                print(f"   Confidence: {endpoint.get('confidence', 0):.1%}")
                
                # Show verification results if available
                if endpoint.get('verified'):
                    store_count = endpoint.get('verified_store_count', 0)
                    verified_type = endpoint.get('verified_type', 'unknown')
                    print(f"   ✅ VERIFIED: {store_count} stores | Type: {verified_type}")
                    if endpoint.get('data_path'):
                        print(f"   Data Path: {endpoint.get('data_path')}")
                    if endpoint.get('sample_stores'):
                        print(f"   Sample: {len(endpoint.get('sample_stores', []))} stores preview")
                elif endpoint.get('store_count'):
                    print(f"   Stores detected: {endpoint.get('store_count')}")
                elif endpoint.get('verification_error'):
                    print(f"   ⚠️  Verification failed: {endpoint.get('verification_error', '')[:60]}")
                
                print()
        
        if result.get('suggested_config'):
            print("📋 Suggested Brand Configuration:\n")
            print(json.dumps(result['suggested_config'], indent=2))
    else:
        print(f"❌ Failed to discover endpoints")
        if result['errors']:
            print("\nErrors:")
            for error in result['errors']:
                print(f"  - {error}")
    
    # Save to file if requested
    if args.output:
        with open(args.output, 'w') as f:
            json.dump(result, f, indent=2)
        print(f"\n💾 Results saved to: {args.output}")


if __name__ == "__main__":
    main()

