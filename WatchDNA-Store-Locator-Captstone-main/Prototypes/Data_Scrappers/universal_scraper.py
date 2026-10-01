#!/usr/bin/env python3
"""
Universal Store Locator Scraper
================================

ONE script that handles EVERYTHING:
- Auto-detects if endpoint is region-specific or returns all stores
- Auto-detects viewport/country/pagination patterns
- Auto-expands to get worldwide data if needed
- Auto-maps fields
- Normalizes and validates

Usage:
    python3 universal_scraper.py --url "ANY_STORE_LOCATOR_URL"
"""

import argparse
import re
import sys
import os
import time
import json
from typing import Dict, List, Any, Optional, Tuple
from urllib.parse import urlparse, urljoin

from scraper_utils import log_debug, dict_get_ci


# ---------------------------------------------------------------------------
# Country-name normalisation (built once at module load from Babel + pycountry)
# ---------------------------------------------------------------------------

def _build_country_name_map() -> dict:
    """
    Return a dict mapping any known country-name variant (lower-case) to the
    ISO 3166 canonical English name.  Covers ~3 500+ variants across all major
    languages by combining:
      • pycountry  – alpha_2, alpha_3, English name, official_name, common_name
      • Babel      – localised territory names for every locale in the CLDR data
    Falls back gracefully if either library is unavailable.
    """
    mapping: dict = {}
    try:
        import pycountry
        for c in pycountry.countries:
            eng = c.name
            for key in (c.alpha_2, c.alpha_3, eng,
                        getattr(c, 'common_name', None),
                        getattr(c, 'official_name', None)):
                if key:
                    mapping[key.lower()] = eng
    except Exception:
        pass

    try:
        from babel import Locale
        import pycountry as _pc
        for locale_code in [
            'af', 'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy',
            'da', 'de', 'el', 'en', 'es', 'et', 'eu', 'fa', 'fi', 'fr',
            'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is',
            'it', 'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'ky', 'lo', 'lt',
            'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'my', 'nb', 'ne', 'nl',
            'or', 'pa', 'pl', 'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'sq',
            'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tl', 'tr', 'uk', 'ur',
            'uz', 'vi', 'zh', 'zu',
        ]:
            try:
                loc = Locale.parse(locale_code)
                for alpha2, local_name in loc.territories.items():
                    c = _pc.countries.get(alpha_2=alpha2)
                    if c and local_name:
                        mapping[local_name.lower()] = c.name
            except Exception:
                pass
    except Exception:
        pass

    # Manual overrides for common abbreviations / colloquial names not in CLDR
    mapping.update({
        'uk': 'United Kingdom',
        'usa': 'United States',
        'u.s.a.': 'United States',
        'u.s.': 'United States',
        'uae': 'United Arab Emirates',
        'u.a.e.': 'United Arab Emirates',
        'south korea': 'South Korea',
        'north korea': 'North Korea',
        'taiwan': 'Taiwan',
        'hong kong': 'Hong Kong',
        'macau': 'Macao',
        'macao': 'Macao',
        'czech republic': 'Czechia',
        'slovak republic': 'Slovakia',
        'ivory coast': "Côte d'Ivoire",
        'congo': 'Congo',
        'dr congo': 'Congo, The Democratic Republic of the',
        'drc': 'Congo, The Democratic Republic of the',
        'trinidad': 'Trinidad and Tobago',
    })
    return mapping


_COUNTRY_NAME_MAP: dict = _build_country_name_map()


def _normalize_country(name: str) -> str:
    """Return the canonical English country name, or the original string if unknown."""
    return _COUNTRY_NAME_MAP.get(name.lower().strip(), name.strip())


# ---------------------------------------------------------------------------
# Worldwide postal-code helpers
# ---------------------------------------------------------------------------

# Ordered list of (pattern_str, description) used to detect postal codes.
# More-specific formats come first to avoid partial matches by the catch-all.
_POSTAL_PATTERNS = [
    # UK  e.g. SW1A 1AA, EC1A 1BB, W1A 0AX
    r'[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}',
    # Canada  e.g. M5V 3A8, T2P 3C3
    r'[A-Z]\d[A-Z]\s*\d[A-Z]\d',
    # Netherlands  e.g. 3421 AG, 1017 RZ  (4 digits + 2 uppercase letters)
    r'\d{4}\s+[A-Z]{2}',
    # Sweden / Czech / Slovakia  e.g. 113 47, 160 00  (3 digits + 2 digits)
    r'\d{3}\s+\d{2}',
    # US ZIP+4  e.g. 12345-6789
    r'\d{5}-\d{4}',
    # Brazil / Japan / Poland  e.g. 01310-100, 141-0021, 00-001
    r'\d{2,5}-\d{3,4}',
    # Generic 4–6 digit  (AU, AT, BE, CH, DE, DK, ES, FI, FR, HU, IT, NO, …)
    r'\d{4,6}',
]

# Single compiled regex that matches any postal-code token (anchored as full token)
_POSTAL_TOKEN_RE = re.compile(
    r'^(?:' + '|'.join(_POSTAL_PATTERNS) + r')$', re.IGNORECASE
)


def _split_postal_prefix(text: str):
    """
    If *text* starts with a postal code followed by at least one space and
    more content (e.g. '3421 AG Oudewater', '1204 Geneva'), return
    ``(postal, rest)``.  Otherwise return ``(None, text)``.
    """
    for pat in _POSTAL_PATTERNS:
        m = re.match(r'^(' + pat + r')\s+(.+)$', text, re.IGNORECASE)
        if m:
            return m.group(1).strip(), m.group(2).strip()
    return None, text


def _split_postal_suffix(text: str):
    """
    If *text* ends with a postal code (e.g. 'Tokyo 141-0021', 'Riyadh 12329'),
    return ``(city, postal)``.  Otherwise return ``(text, None)``.
    """
    for pat in _POSTAL_PATTERNS:
        m = re.match(r'^(.+?)\s+(' + pat + r')$', text, re.IGNORECASE)
        if m:
            return m.group(1).strip(), m.group(2).strip()
    return text, None


def _get_custom_headers(brand_config: Optional[Dict]) -> Optional[Dict]:
    """Return per-brand custom HTTP headers from brand_config, or None."""
    if brand_config:
        headers = brand_config.get("custom_headers")
        if headers and isinstance(headers, dict):
            return headers
    return None


def _country_expansion_request_headers(brand_config: Optional[Dict]) -> Dict[str, str]:
    """Headers for scrape_country_expansion (JSON APIs + optional custom_headers / legacy headers)."""
    merged: Dict[str, str] = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    extra = _get_custom_headers(brand_config)
    if extra:
        merged.update(extra)
    if brand_config and isinstance(brand_config.get("headers"), dict):
        merged.update(brand_config["headers"])
    return merged


# Request/retry constants
DEFAULT_REQUEST_TIMEOUT = 120
DEFAULT_RETRIES = 3
DEFAULT_BACKOFF_FACTOR = 2
DEFAULT_VIEWPORT_GRID_SIZE = 20
DEFAULT_DELAY_BETWEEN_REQUESTS = 0.5

# Add paths
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "tools"))

from locator_type_detector import detect_locator_type


def _print_technique_comparison(technique_metrics: Dict[str, Any]) -> None:
    """Print comparison table of extraction technique results."""
    print("\n📊 EXTRACTION TECHNIQUE COMPARISON")
    print("=" * 60)
    for name, m in technique_metrics.items():
        total = m.get("total", 0)
        score = m.get("completeness_score", 0)
        pcts = m.get("pcts", {})
        print(f"\n  {name}:")
        print(f"    Stores: {total}  |  Completeness: {score}%")
        if pcts:
            parts = [f"{k.replace('_pct','')}:{v}%" for k, v in list(pcts.items())[:6]]
            print(f"    Fields: {', '.join(parts)}")
    print("=" * 60)


def _collect_data_quality_warnings(stores: List[Dict[str, Any]]) -> List[str]:
    """Scan normalized stores for data-quality issues and return warning messages."""
    if not stores:
        return []
    no_name = sum(1 for s in stores if not (s.get("Name") or "").strip())
    no_coords = sum(
        1
        for s in stores
        if not (s.get("Latitude") or "").strip() or not (s.get("Longitude") or "").strip()
    )
    no_address = sum(1 for s in stores if not (s.get("Address Line 1") or "").strip())
    no_phone = sum(1 for s in stores if not (s.get("Phone") or "").strip())
    warnings = []
    if no_name:
        warnings.append(f"{no_name} store(s) have no name")
    if no_coords:
        warnings.append(f"{no_coords} store(s) have missing or invalid coordinates")
    if no_address:
        warnings.append(f"{no_address} store(s) have no address")
    if no_phone:
        warnings.append(f"{no_phone} store(s) have no phone number")
    return warnings
from pattern_detector import detect_data_pattern
from data_normalizer import batch_normalize, write_normalized_csv
from validate_csv import CSVValidator, DEFAULT_REQUIRED
from extraction_techniques import (
    extract_stores_from_html_generic,
    enrich_stores_from_detail_pages,
    compute_extraction_metrics,
    run_extraction_with_techniques,
)


def fetch_data(url: str, headers: Optional[Dict] = None, timeout: int = DEFAULT_REQUEST_TIMEOUT, retries: int = DEFAULT_RETRIES) -> Any:
    """
    Fetch data from URL with retry logic and configurable timeout
    
    Args:
        url: URL to fetch
        headers: Optional custom headers
        timeout: Request timeout in seconds (default: 120)
        retries: Number of retry attempts (default: 3)
    
    Returns:
        Parsed JSON data or HTML/text content
    """
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    
    log_debug(f"Fetching data from: {url[:100]}...", "DEBUG")
    start_time = time.time()
    
    # Default headers
    default_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    # Merge with custom headers if provided
    if headers:
        default_headers.update(headers)
    
    # Create session with retry strategy
    session = requests.Session()
    
    # Configure retry strategy
    retry_strategy = Retry(
        total=retries,
        backoff_factor=DEFAULT_BACKOFF_FACTOR,
        status_forcelist=[429, 500, 502, 503, 504],  # Retry on these status codes
        allowed_methods=["GET", "HEAD"]  # Only retry safe methods
    )
    
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    
    # Attempt request with retries
    last_error = None
    for attempt in range(retries + 1):
        try:
            if attempt > 0:
                wait_time = 2 ** attempt  # Exponential backoff: 2, 4, 8 seconds
                log_debug(f"Retry attempt {attempt}/{retries} after {wait_time}s...", "WARN")
                time.sleep(wait_time)
            
            response = session.get(url, timeout=timeout, headers=default_headers)
            response.raise_for_status()
            
            elapsed = time.time() - start_time
            log_debug(f"Response received: {response.status_code} | Size: {len(response.content)} bytes | Time: {elapsed:.2f}s", "DEBUG")
            
            try:
                data = response.json()
                log_debug(f"Response type: JSON | Top-level keys: {list(data.keys()) if isinstance(data, dict) else 'array'}", "DEBUG")
                return data
            except (ValueError, json.JSONDecodeError):
                # Try JSONP (e.g. callback([...]) or SMcallback2([...]))
                data = _parse_jsonp(response.text)
                if data is not None:
                    log_debug(f"Response type: JSONP | Parsed successfully", "DEBUG")
                    return data
                log_debug(f"Response type: HTML/Text | Length: {len(response.text)} chars", "DEBUG")
                return response.text
                
        except requests.exceptions.Timeout as e:
            last_error = e
            if attempt < retries:
                log_debug(f"Request timed out after {timeout}s (attempt {attempt + 1}/{retries + 1})", "WARN")
                continue
            else:
                log_debug(f"Request timed out after {retries + 1} attempts", "ERROR")
                raise
        except requests.exceptions.RequestException as e:
            last_error = e
            if attempt < retries:
                log_debug(f"Request failed: {str(e)[:100]} (attempt {attempt + 1}/{retries + 1})", "WARN")
                continue
            else:
                raise
    
    # If we get here, all retries failed
    if last_error:
        raise last_error
    raise Exception("Failed to fetch data after all retries")


def _parse_jsonp(text: str):
    """
    Parse JSONP response (e.g. callback([...]) or SMcallback2([...])).
    Returns parsed JSON or None if not valid JSONP.
    """
    text = text.strip()
    start = text.find('(')
    if start == -1:
        return None
    i = start + 1
    depth = 1
    in_string = False
    escape = False
    quote_char = None
    while i < len(text):
        c = text[i]
        if escape:
            escape = False
            i += 1
            continue
        if in_string:
            if c == '\\':
                escape = True
            elif c == quote_char:
                in_string = False
            i += 1
            continue
        if c in '"\'':
            in_string = True
            quote_char = c
            i += 1
            continue
        if c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start + 1:i])
                except json.JSONDecodeError:
                    return None
        i += 1
    return None


def _extract_stores_from_html_cards(soup) -> List[Dict]:
    """
    Generic fallback: extract store/retailer cards from HTML when no API or JSON found.
    Tries multiple patterns to find containers with: heading (name) + address block + optional maps link.
    Works with various page structures (Tailwind, Bootstrap, custom CSS, etc.).
    """
    import re
    stores = []

    def _parse_card(card) -> Optional[Dict]:
        """Parse a single card element into a store dict, or None if invalid."""
        # Name: from h2, h3, or h4 (first one found)
        heading = card.find(['h2', 'h3', 'h4'])
        if not heading:
            return None
        name = heading.get_text(strip=True)
        if not name or len(name) < 2 or len(name) > 120:
            return None
        store = {'Name': name}
        # Address block: p tags (common pattern)
        ps = card.find_all('p')
        if len(ps) >= 1:
            store['Address Line 1'] = ps[0].get_text(strip=True)
        if len(ps) >= 2:
            city_state_zip = ps[1].get_text(strip=True)
            store['City'] = city_state_zip.split(',')[0].strip() if ',' in city_state_zip else city_state_zip
            parts = re.split(r',\s*', city_state_zip, 2)
            if len(parts) >= 2:
                store['State/Province/Region'] = re.sub(r'\s*\d{4,6}(?:-\d{4})?\s*$', '', parts[1]).strip()
            zip_match = re.search(r'\b(\d{4,6}(?:-\d{4})?)\b', city_state_zip)
            if zip_match:
                store['Postal/ZIP Code'] = zip_match.group(1)
        if len(ps) >= 3:
            store['Country'] = ps[2].get_text(strip=True)
        # Coords: Google Maps destination=lat,lng (or maps.google.com, openstreetmap, etc.)
        for link in card.find_all('a', href=True):
            href = link.get('href', '')
            m = re.search(r'destination=([-\d.]+),([-\d.]+)', href)
            if not m:
                m = re.search(r'@([-\d.]+),([-\d.]+)', href)  # Google Maps @lat,lng
            if not m:
                m = re.search(r'!3d([-\d.]+)!4d([-\d.]+)', href)  # Google Maps embed
            if m:
                store['Latitude'] = m.group(1)
                store['Longitude'] = m.group(2)
                break
        if store.get('Name'):
            return store
        return None

    # Strategy 1: Card-like containers (common class patterns)
    card_patterns = [
        lambda c: c and 'group' in str(c) and 'cursor-pointer' in str(c),
        lambda c: c and ('card' in str(c) or 'store-card' in str(c) or 'retailer' in str(c)),
        lambda c: c and ('border' in str(c) or 'rounded') and ('p-4' in str(c) or 'p-5' in str(c) or 'padding' in str(c)),
        lambda c: c and 'location' in str(c).lower() and ('item' in str(c) or 'card' in str(c)),
    ]
    for pattern in card_patterns:
        cards = soup.find_all('div', class_=pattern)
        for card in cards:
            s = _parse_card(card)
            if s:
                stores.append(s)
        if len(stores) >= 2:  # Need at least 2 to confirm we found a list
            return stores
        stores.clear()

    # Strategy 2: Broader search - containers with heading + address-like content
    addr_hint = re.compile(r'\d|street|st\.|ave|road|rd\.|boulevard|blvd|suite|floor|no\.|n°', re.I)
    seen = set()
    for elem in soup.find_all(['div', 'section', 'article']):
        s = _parse_card(elem)
        if s and (s.get('Address Line 1') or s.get('City')):
            text = elem.get_text()
            if addr_hint.search(text) or s.get('Postal/ZIP Code'):
                key = (s.get('Name', ''), s.get('Address Line 1', ''))
                if key not in seen:
                    seen.add(key)
                    stores.append(s)
    if len(stores) >= 2:
        return stores

    return stores


def _infer_site_origin_for_sfcc(soup: Any, html_content: str) -> Optional[str]:
    """Best-effort https://host origin for resolving relative SFCC links."""
    try:
        link = soup.find("link", rel=lambda v: v and "canonical" in str(v).lower())
        if link and link.get("href"):
            p = urlparse(link["href"])
            if p.scheme and p.netloc:
                return f"{p.scheme}://{p.netloc}"
    except (TypeError, AttributeError, KeyError):
        pass
    m = re.search(r"(https?://[^/\"'\s>]+)/on/demandware", html_content)
    if m:
        return m.group(1).rstrip("/")
    return None


def _parse_sfcc_city_state_zip(block: str) -> Tuple[str, str, str]:
    """Parse SFCC infoWindow lines like 'Tempe, AZ 85281' into city, state, postal."""
    if not block:
        return "", "", ""
    text = re.sub(r"\s+", " ", block.strip())
    m = re.match(
        r"^([^,]+),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d|\d{4}\s*[A-Za-z]{2})$",
        text,
    )
    if m:
        return m.group(1).strip(), m.group(2).upper(), m.group(3).strip()
    parts = [p.strip() for p in text.split(",")]
    if len(parts) >= 2:
        city = parts[0]
        tail = ",".join(parts[1:])
        m2 = re.search(
            r"\b([A-Za-z]{2})\b\s+(\d{5}(?:-\d{4})?|[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d|\d{4}\s*[A-Za-z]{2})\s*$",
            tail,
        )
        if m2:
            return city, m2.group(1).upper(), m2.group(2).strip()
    return text, "", ""


def _sfcc_map_pin_to_store(pin: Dict[str, Any], origin: Optional[str]) -> Optional[Dict[str, str]]:
    """One SFCC map pin (from data-locations JSON) -> canonical scraper dict."""
    if not isinstance(pin, dict):
        return None
    lat, lng = pin.get("latitude"), pin.get("longitude")
    if lat is None or lng is None:
        return None
    name = str(pin.get("name") or "").strip()
    hid = str(pin.get("id") or "").strip()
    if not name and not hid:
        return None
    store: Dict[str, str] = {
        "Handle": hid or name,
        "Name": name or hid,
        "Latitude": str(lat).strip(),
        "Longitude": str(lng).strip(),
    }
    frag = pin.get("infoWindowHtml") or ""
    if not frag:
        return store
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return store

    inner = BeautifulSoup(frag, "html.parser")
    line1_el = inner.select_one(".store-address")
    if line1_el:
        store["Address Line 1"] = line1_el.get_text(" ", strip=True)
    city_el = inner.select_one(".store-city-state-zip")
    if city_el:
        c, st, z = _parse_sfcc_city_state_zip(city_el.get_text(" ", strip=True))
        if c:
            store["City"] = c
        if st:
            store["State/Province/Region"] = st
        if z:
            store["Postal/ZIP Code"] = z
    phone_el = inner.select_one("a.storelocator-phone")
    if phone_el:
        store["Phone"] = phone_el.get_text(strip=True)
    detail_a = inner.select_one(".store-name a[href]")
    if detail_a and detail_a.get("href") and origin:
        store["Website"] = urljoin(origin + "/", detail_a["href"])
    return store


def extract_stores_from_sfcc_data_locations(html_content: str) -> List[Dict]:
    """
    Salesforce Commerce Cloud (Demandware) store locator HTML: map markers are
    serialized JSON in data-locations=\"[...]\" (e.g. Bulova). Does not run for
    SFCC endpoints that return application/json (those use the JSON path).
    """
    if "data-locations" not in html_content:
        return []
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return []

    soup = BeautifulSoup(html_content, "html.parser")
    origin = _infer_site_origin_for_sfcc(soup, html_content)
    by_handle: Dict[str, Dict] = {}

    for el in soup.find_all(attrs={"data-locations": True}):
        raw = el.get("data-locations") or ""
        if not raw or not raw.strip() or raw.strip() == "[]":
            continue
        try:
            pins = json.loads(raw)
        except json.JSONDecodeError:
            import html as html_module

            try:
                pins = json.loads(html_module.unescape(raw))
            except json.JSONDecodeError:
                continue
        if not isinstance(pins, list):
            continue
        for pin in pins:
            rec = _sfcc_map_pin_to_store(pin, origin)
            if rec:
                by_handle[rec["Handle"]] = rec

    return list(by_handle.values())


def extract_stores_from_sm_block_data_latlng(html_content: str) -> List[Dict]:
    """
    WordPress theme fragments (e.g. Edox): .sm-block rows with data-latlng="lat,lng",
    h4.stitle name, .saddress with address <p> and Tel./Mail./Web. labels.
    """
    if "data-latlng" not in html_content or "sm-block" not in html_content:
        return []
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return []

    soup = BeautifulSoup(html_content, "html.parser")
    blocks = soup.select(".sm-block[data-latlng]")
    if not blocks:
        return []

    def _strip_nbsp(s: str) -> str:
        return re.sub(r"[\u00a0\xa0\u2007\u202f]+", " ", s or "").strip()

    stores: List[Dict] = []
    skip_names = re.compile(r"^edox\s+stores$", re.I)

    for block in blocks:
        raw_ll = (block.get("data-latlng") or "").strip()
        parts = [p.strip() for p in raw_ll.split(",") if p.strip()]
        if len(parts) != 2:
            continue
        try:
            lat_f = float(parts[0])
            lng_f = float(parts[1])
        except ValueError:
            continue

        title_el = block.select_one("h4.stitle") or block.find("h4")
        name = _strip_nbsp(title_el.get_text()) if title_el else ""
        if not name or skip_names.match(name):
            continue

        store: Dict[str, Any] = {
            "Name": name,
            "Latitude": str(lat_f),
            "Longitude": str(lng_f),
        }

        bid = block.get("id") or ""
        if bid.startswith("store_"):
            store["Handle"] = bid.replace("store_", "", 1)

        saddr = block.select_one(".saddress") or block.find("address")
        if saddr:
            first_p = saddr.find("p")
            if first_p:
                store["Address Line 1"] = _strip_nbsp(first_p.get_text())

            for label in saddr.find_all("label"):
                span = label.find("span")
                if not span:
                    continue
                kind = _strip_nbsp(span.get_text()).lower().rstrip(".")
                if kind == "tel":
                    t = _strip_nbsp(label.get_text())
                    t = re.sub(r"^tel\.?\s*", "", t, flags=re.I).strip()
                    if t:
                        store["Phone"] = t
                elif kind == "mail":
                    a = label.find("a", href=True)
                    if a and "mailto:" in (a.get("href") or ""):
                        store["Email"] = a["href"].split("mailto:", 1)[-1].strip()
                    else:
                        t = _strip_nbsp(label.get_text())
                        t = re.sub(r"^mail\.?\s*", "", t, flags=re.I).strip()
                        if t:
                            store["Email"] = t
                elif kind == "web":
                    a = label.find("a", href=True)
                    if a:
                        href = (a.get("href") or "").strip()
                        if href.startswith("http"):
                            store["Website"] = href

        stores.append(store)

    return stores


def extract_stores_from_html_js(html_content: str) -> List[Dict]:
    """Extract stores from HTML pages with embedded JavaScript or structured HTML"""
    sfcc_stores = extract_stores_from_sfcc_data_locations(html_content)
    if sfcc_stores:
        return sfcc_stores

    edox_like = extract_stores_from_sm_block_data_latlng(html_content)
    if edox_like:
        log_debug(
            f"Extracted {len(edox_like)} stores from .sm-block[data-latlng] (WordPress/Edox-style)",
            "SUCCESS",
        )
        return edox_like

    stores = []
    
    # Method 1: Try to find JSON patterns in HTML (original method)
    pattern = r'"name":"([^"]+)"[^}]*?"cityName":"([^"]*)"[^}]*?"countryName":"([^"]+)"[^}]*?"latitude":([^,]+),"longitude":([^,}]+)'
    matches = re.finditer(pattern, html_content)
    
    for match in matches:
        start = max(0, match.start() - 500)
        end = min(len(html_content), match.end() + 500)
        context = html_content[start:end]
        
        store = {
            'name': match.group(1),
            'cityName': match.group(2),
            'countryName': match.group(3),
            'latitude': match.group(4),
            'longitude': match.group(5),
        }
        
        field_patterns = {
            'adr': r'"adr":"([^"]*)"',
            'address': r'"address":"([^"]*)"',
            'streetAddress': r'"streetAddress":"([^"]*)"',
            'zipcode': r'"zipcode":"([^"]*)"',
            'postalCode': r'"postalCode":"([^"]*)"',
            'stateName': r'"stateName":"([^"]*)"',
            'id': r'"id":"([^"]*)"',
            'phone': r'"phone":"([^"]*)"',
            'email': r'"email":"([^"]*)"',
            'websiteUrl': r'"websiteUrl":"([^"]*)"',
        }
        
        for field, pat in field_patterns.items():
            field_match = re.search(pat, context)
            if field_match:
                store[field] = field_match.group(1)
        
        # Map to canonical field names that the normalizer expects
        normalized_store = {
            'Name': store.get('name', ''),
            'City': store.get('cityName', ''),
            'Country': store.get('countryName', ''),
            'Latitude': store.get('latitude', ''),
            'Longitude': store.get('longitude', ''),
            'Address Line 1': store.get('streetAddress') or store.get('address') or store.get('adr', ''),
            'Postal/ZIP Code': store.get('postalCode') or store.get('zipcode', ''),
            'State/Province/Region': store.get('stateName', ''),
            'Phone': store.get('phone', ''),
            'Email': store.get('email', ''),
            'Website': store.get('websiteUrl', ''),
            'Handle': store.get('id', ''),
        }
        
        stores.append(normalized_store)
    
    # Method 2: Try to extract JSON from script tags (e.g., Drupal JSON data)
    if not stores:
        try:
            import json
            from bs4 import BeautifulSoup
            
            soup = BeautifulSoup(html_content, 'html.parser')
            
            # Look for script tags with JSON data (e.g., Drupal settings)
            script_tags = soup.find_all('script', type='application/json')
            
            for script_tag in script_tags:
                try:
                    script_data = json.loads(script_tag.string)
                    
                    # Check for Blancpain points of sale data
                    if isinstance(script_data, dict):
                        # Look for points_of_sale in various possible locations
                        pos_data = None
                        if 'blancpain_points_of_sale' in script_data:
                            pos_data = script_data['blancpain_points_of_sale']
                        elif 'points_of_sale' in script_data:
                            pos_data = script_data['points_of_sale']
                        elif 'data' in script_data and 'points_of_sale' in script_data['data']:
                            pos_data = script_data['data']['points_of_sale']
                        
                        if pos_data and isinstance(pos_data, dict) and 'points_of_sale' in pos_data:
                            pos_list = pos_data['points_of_sale']
                        elif isinstance(pos_data, list):
                            pos_list = pos_data
                        else:
                            continue
                        
                        # Extract stores from the JSON array
                        for pos in pos_list:
                            if not isinstance(pos, dict):
                                continue
                            
                            store = {}
                            
                            # Map fields from JSON to canonical format
                            store['Name'] = pos.get('title', '')
                            store['Address Line 1'] = pos.get('address_1', '')
                            store['Address Line 2'] = pos.get('address_2', '')
                            store['City'] = pos.get('city', '')
                            store['State/Province/Region'] = pos.get('state', '')
                            store['Country'] = pos.get('country', '')
                            store['Postal/ZIP Code'] = pos.get('zip', '')
                            store['Phone'] = pos.get('phone', '')
                            store['Email'] = pos.get('email', '')
                            store['Website'] = pos.get('website', '')
                            
                            # Handle URL (might be relative)
                            url = pos.get('url', '')
                            if url and not url.startswith('http'):
                                url = 'https://www.blancpain.com' + url
                            if url and not store.get('Website'):
                                store['Website'] = url
                            
                            # Handle coordinates (array format: [lng, lat])
                            coords = pos.get('coordinates', [])
                            if isinstance(coords, list) and len(coords) >= 2:
                                store['Longitude'] = str(coords[0])
                                store['Latitude'] = str(coords[1])
                            
                            # Handle ID as handle
                            if pos.get('id'):
                                store['Handle'] = str(pos.get('id'))
                            
                            # Only add if we have at least a name
                            if store.get('Name'):
                                stores.append(store)
                        
                        if stores:
                            log_debug(f"Extracted {len(stores)} stores from JSON script tag", "SUCCESS")
                            break
                            
                except (json.JSONDecodeError, AttributeError, KeyError) as e:
                    continue
            
            # Method 3: data-lat / data-lng attribute elements (Drupal Geolocation module and similar)
            # Elements carry coordinates as HTML attributes alongside structured address markup.
            # Cross-reference with sibling card elements (by name) to pick up phone/email/website.
            if not stores:
                geo_elements = soup.find_all(attrs={'data-lat': True, 'data-lng': True})
                if geo_elements:
                    # Build a name → card lookup from visible store cards for enrichment
                    card_by_name = {}
                    for card in soup.find_all(class_=re.compile(r'store-wrapper|store-card|retailer-card|location-card', re.I)):
                        heading = card.find(['h2', 'h3', 'h4'])
                        if heading:
                            card_by_name[heading.get_text(strip=True).lower()] = card

                    # Drupal region-continent suffixes that are not real country names
                    _REGION_SUFFIX = re.compile(
                        r',?\s*(Asia|Europe|Americas|Africa|Oceania|Middle\s+East|APAC)\s*$',
                        re.I,
                    )

                    def _clean_para(text: str) -> str:
                        """Normalise non-breaking spaces and strip trailing commas/whitespace."""
                        text = re.sub(r'[\u00a0\xa0]+', ' ', text)
                        return text.strip().rstrip(',').strip()

                    def _parse_last_para(text: str) -> dict:
                        """
                        Parse the final address paragraph into structured fields.

                        Handles any combination of:
                          postal-code prefix  (any world format via _split_postal_prefix)
                          dash/em-dash separator before the country
                          comma-separated city, country
                          state + postal code (e.g. "WA 6017")
                          plain country name in any language (_normalize_country)

                        Examples:
                          "Japan"                           → {Country: Japan}
                          "Malaysia, Asia"                  → {Country: Malaysia}
                          "Suisse"                          → {Country: Switzerland}
                          "WA 6017 – Australia"             → {State: WA, Postal: 6017, Country: Australia}
                          "10310 Thailand"                  → {Postal: 10310, Country: Thailand}
                          "1204 Geneva, Suisse"             → {Postal: 1204, City: Geneva, Country: Switzerland}
                          "1017 RZ Amsterdam - Netherlands" → {Postal: 1017 RZ, City: Amsterdam, Country: Netherlands}
                          "3421 AG Oudewater"               → {Postal: 3421 AG, City: Oudewater}
                          "Ras Al Khaimah - United Arab Emirates" → {City: Ras Al Khaimah, Country: UAE}
                        """
                        out: dict = {}
                        text = _REGION_SUFFIX.sub('', text).strip()

                        # ── dash/em-dash separator: "left – Country" ────────────────
                        dash_m = re.match(r'^(.+?)\s*[–\-]\s*(.+)$', text)
                        if dash_m:
                            left    = dash_m.group(1).strip()
                            country = dash_m.group(2).strip()
                            out['Country'] = _normalize_country(country)
                            # left may be "WA 6017" (state + postal) or "1017 RZ Amsterdam" or plain city
                            state_postal = re.match(r'^([A-Z]{1,3})\s+(\d{3,6})$', left)
                            postal, rest = _split_postal_prefix(left)
                            if state_postal:
                                out['State/Province/Region'] = state_postal.group(1)
                                out['Postal/ZIP Code']       = state_postal.group(2)
                            elif postal:
                                out['Postal/ZIP Code'] = postal
                                out['City']            = rest
                            else:
                                out['City'] = left
                            return out

                        # ── starts with a postal code ───────────────────────────────
                        postal, rest = _split_postal_prefix(text)
                        if postal:
                            # rest may be "City, Country", "Country", or just "City"
                            if ',' in rest:
                                city_part, country_part = rest.rsplit(',', 1)
                                out['Postal/ZIP Code'] = postal
                                out['City']    = city_part.strip()
                                out['Country'] = _normalize_country(country_part)
                            else:
                                # Decide if rest is a known country or a city name.
                                # If it resolves to a known country we treat it as country-only.
                                normalised = _normalize_country(rest)
                                if normalised != rest or rest.lower() in _COUNTRY_NAME_MAP:
                                    out['Postal/ZIP Code'] = postal
                                    out['Country']         = normalised
                                else:
                                    # Unrecognised as country → treat as city (no country known)
                                    out['Postal/ZIP Code'] = postal
                                    out['City']            = rest
                            return out

                        # ── plain "City, Country" or plain country ──────────────────
                        if ',' in text:
                            city_part, country_part = text.rsplit(',', 1)
                            out['City']    = city_part.strip()
                            out['Country'] = _normalize_country(country_part)
                        else:
                            out['Country'] = _normalize_country(text)
                        return out

                    def _parse_penultimate_para(text: str, store: dict) -> None:
                        """
                        Fill City / Postal from the second-to-last address paragraph when
                        _parse_last_para didn't set them.

                        Handles any world postal-code format via the module-level
                        _split_postal_suffix / _split_postal_prefix helpers, plus
                        comma-separated district/city patterns.

                        Examples:
                          "Tokyo 141-0021"              → City: Tokyo,      Postal: 141-0021
                          "Riyadh 12329"                → City: Riyadh,     Postal: 12329
                          "59200 Kuala Lumpur"          → City: Kuala Lumpur, Postal: 59200
                          "KL Gateway, 59200 Kuala Lumpur" → City: Kuala Lumpur, Postal: 59200
                          "Songpa-gu, Seoul"            → City: Seoul
                        """
                        if store.get('City') and store.get('Postal/ZIP Code'):
                            return

                        # Try postal at end: "Tokyo 141-0021"
                        if not (store.get('City') and store.get('Postal/ZIP Code')):
                            city, postal = _split_postal_suffix(text)
                            if postal and city:
                                if not store.get('City'):
                                    store['City'] = city
                                if not store.get('Postal/ZIP Code'):
                                    store['Postal/ZIP Code'] = postal
                                return

                        # Try postal at start: "59200 Kuala Lumpur"
                        if not store.get('City'):
                            postal, city = _split_postal_prefix(text)
                            if postal and city:
                                if not store.get('Postal/ZIP Code'):
                                    store['Postal/ZIP Code'] = postal
                                store['City'] = city
                                return

                        # Comma-separated: take the last segment as the city candidate
                        # e.g. "KL Gateway, 59200 Kuala Lumpur" or "Songpa-gu, Seoul"
                        if ',' in text and not store.get('City'):
                            candidate = text.rsplit(',', 1)[-1].strip()
                            # candidate may still start with a postal code
                            postal2, city2 = _split_postal_prefix(candidate)
                            if postal2 and city2:
                                if not store.get('Postal/ZIP Code'):
                                    store['Postal/ZIP Code'] = postal2
                                store['City'] = city2
                            else:
                                store['City'] = candidate

                    for el in geo_elements:
                        lat = el.get('data-lat', '').strip()
                        lng = el.get('data-lng', '').strip()
                        if not lat or not lng:
                            continue

                        # Name: prefer a dedicated title field, fall back to first heading
                        title_el = el.find(class_=re.compile(r'views-field-title|location-title|store-name', re.I))
                        name = title_el.get_text(strip=True) if title_el else ''
                        if not name:
                            h = el.find(['h2', 'h3', 'h4'])
                            name = h.get_text(strip=True) if h else ''
                        if not name:
                            continue

                        store = {'Name': name, 'Latitude': lat, 'Longitude': lng}

                        # Address: collect cleaned <p> lines from the address field block
                        addr_block = el.find(class_=re.compile(r'views-field-field-address|address|location-address', re.I))
                        if addr_block:
                            paras = [_clean_para(p.get_text()) for p in addr_block.find_all('p')]
                            paras = [p for p in paras if p]

                            if paras:
                                parsed_last = _parse_last_para(paras[-1])
                                store.update(parsed_last)

                                # Remaining lines before the last
                                body = paras[:-1]
                                if body:
                                    store['Address Line 1'] = body[0]
                                if len(body) >= 2:
                                    store['Address Line 2'] = body[1]
                                # Try to extract City/Postal from the second-to-last body line
                                if len(body) >= 2:
                                    _parse_penultimate_para(body[-1], store)

                        # Enrich from matching visible card (phone, email, website)
                        card = card_by_name.get(name.lower())
                        if card:
                            phone_el = card.find(class_=re.compile(r'phone', re.I))
                            if phone_el:
                                store['Phone'] = phone_el.get_text(strip=True)
                            email_el = card.find(class_=re.compile(r'email', re.I))
                            if email_el:
                                a = email_el.find('a')
                                if a:
                                    href = a.get('href', '')
                                    # Drupal contact links: /contact?recipient=email@addr
                                    m = re.search(r'recipient=([^&]+)', href)
                                    store['Email'] = m.group(1) if m else a.get_text(strip=True)
                                else:
                                    store['Email'] = email_el.get_text(strip=True)
                            website_el = card.find(class_=re.compile(r'website', re.I))
                            if website_el:
                                a = website_el.find('a')
                                store['Website'] = a.get('href') if a else website_el.get_text(strip=True)

                        stores.append(store)

                    if stores:
                        log_debug(f"Extracted {len(stores)} stores from data-lat/data-lng elements", "SUCCESS")

            # Method 4: Generic HTML fallback - parse store/retailer cards from any page structure
            if not stores:
                stores = _extract_stores_from_html_cards(soup)
                if stores:
                    log_debug(f"Extracted {len(stores)} stores from HTML cards (generic fallback)", "SUCCESS")

            # Method 5: Look for headings with boutique/store names (Blancpain-style)
            if not stores:
                headings = soup.find_all(['h2', 'h3'], string=re.compile(r'Boutique|Store|Retailer', re.I))
                
                for heading in headings:
                    store = {}
                    
                    # Get name from heading
                    name_link = heading.find('a')
                    if name_link:
                        name = name_link.get_text().strip()
                        store['Name'] = name
                        href = name_link.get('href', '')
                        if href and not href.startswith('http'):
                            href = 'https://www.blancpain.com' + href
                        store['Website'] = href
                    else:
                        name = heading.get_text().strip()
                        store['Name'] = name
                    
                    # Extract city and country from name (e.g., "Blancpain Boutique Zürich, Switzerland")
                    name_parts = re.match(r'.*?Boutique\s+([^,]+),?\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)$', name, re.I)
                    if name_parts:
                        store['City'] = name_parts.group(1).strip()
                        store['Country'] = name_parts.group(2).strip()
                    
                    # Get parent container
                    parent = heading.find_parent(['div', 'section', 'article'])
                    if parent:
                        # Get text content, but exclude the heading itself
                        heading_text = heading.get_text()
                        text = parent.get_text()
                        # Remove heading text from parent text to avoid duplication
                        text = text.replace(heading_text, '', 1).strip()
                        
                        # Extract address (look for street patterns, exclude store name)
                        address_patterns = [
                            r'([A-Z][a-z]+.*?(?:Road|Street|Avenue|Rue|Boulevard|Building|Shop|Floor|No-).*?)(?:\n|,|$)',
                            r'(Building No-[0-9]+.*?)(?:\n|,|$)',
                            r'(Shop [A-Z0-9]+.*?)(?:\n|,|$)',
                        ]
                        
                        for pattern in address_patterns:
                            addr_match = re.search(pattern, text, re.MULTILINE)
                            if addr_match:
                                addr = addr_match.group(1).strip()
                                # Clean up address (remove store name if present)
                                addr = re.sub(r'^.*?Boutique\s+', '', addr, flags=re.I)
                                if addr and len(addr) > 5:  # Only use if meaningful
                                    store['Address Line 1'] = addr
                                    break
                        
                        # If city/country not extracted from name, try from text
                        if not store.get('City'):
                            city_country_match = re.search(r'([A-Z][a-z]+(?: [A-Z][a-z]+)?),?\s+([A-Z][a-z]+(?: [A-Z][a-z]+)?)', text)
                            if city_country_match:
                                store['City'] = city_country_match.group(1).strip()
                                store['Country'] = city_country_match.group(2).strip()
                        
                        # Extract postal code (4-6 digits)
                        postal_match = re.search(r'\b(\d{4,6})\b', text)
                        if postal_match:
                            store['Postal/ZIP Code'] = postal_match.group(1)
                    
                    # Only add if we have at least a name
                    if store.get('Name'):
                        stores.append(store)
                    
        except ImportError:
            # BeautifulSoup not available, skip HTML parsing
            pass
        except Exception as e:
            log_debug(f"HTML parsing error: {e}", "WARN")
    
    return stores


def scrape_single_call(
    url: str,
    custom_headers: Optional[Dict] = None,
    compare_techniques: bool = False,
    brand_config: Optional[Dict] = None,
) -> Tuple[List[Dict], Optional[Dict[str, Any]]]:
    """Scrape from single endpoint - handles both JSON and HTML"""
    print("📡 Fetching stores...")
    log_debug("Starting single-call scrape strategy", "DEBUG")

    data = fetch_data(url, headers=custom_headers)

    # Try JSON first
    if isinstance(data, (list, dict)):
        if isinstance(data, list):
            log_debug(f"Data is array | Length: {len(data)}", "DEBUG")
            return data, None

        log_debug(f"Data is object | Searching for store array in keys: {list(data.keys())}", "DEBUG")
        # Brand data_path + shared fallbacks (Storepoint: results.locations, etc.)
        if brand_config:
            extracted = _extract_stores_from_json_for_brand(data, brand_config)
            if extracted:
                log_debug(
                    f"Extracted stores via brand config / nested fallbacks | Length: {len(extracted)}",
                    "SUCCESS",
                )
                return extracted, None

        nested_paths = ["response.entities", "response.data", "response.results",
                       "response.stores", "data.stores", "data.results",
                       "results.locations", "results.stores"]
        for path in nested_paths:
            keys = path.split('.')
            value = data
            for k in keys:
                if isinstance(value, dict) and k in value:
                    value = value[k]
                else:
                    break
            else:
                if isinstance(value, list):
                    log_debug(f"Found stores array in nested path '{path}' | Length: {len(value)}", "SUCCESS")
                    return value, None

        for key in ["entities", "data", "results", "items", "stores", "locations", "dealers", "retailers"]:
            if key in data and isinstance(data[key], list):
                log_debug(f"Found stores array in key '{key}' | Length: {len(data[key])}", "SUCCESS")
                return data[key], None

        log_debug("No stores array found in standard keys", "WARN")
        return [], None

    # HTML with JS - use multi-technique or single
    log_debug("Attempting HTML/JavaScript extraction", "DEBUG")
    if compare_techniques:
        def _fetch(u):
            r = fetch_data(u, headers=custom_headers)
            return r if isinstance(r, str) else ""
        stores, metrics = run_extraction_with_techniques(
            data,
            extract_html_fn=extract_stores_from_html_js,
            fetch_fn=_fetch,
            is_html=True,
        )
        _print_technique_comparison(metrics)
        return stores, metrics
    # Default: try original, then generic if few stores
    stores = extract_stores_from_html_js(data)
    if len(stores) < 5:
        generic = extract_stores_from_html_generic(data)
        if len(generic) > len(stores):
            log_debug(f"Generic extraction found more stores ({len(generic)} vs {len(stores)})", "SUCCESS")
            stores = generic
    return stores, None


def _radius_expansion_request_headers(brand_config: Optional[Dict]) -> Dict[str, str]:
    """Same header merge as country expansion (JSON Accept + custom_headers + legacy headers)."""
    return _country_expansion_request_headers(brand_config)


def _parse_radius_expansion_centers(brand_config: Optional[Dict]) -> Optional[List[Tuple[str, float, float]]]:
    """
    Parse brand_config['radius_expansion_centers'] into (label, lat, lng) tuples.
    Accepts [{ "name": "...", "lat": 1, "lng": 2 }] or [["City", lat, lng], ...].
    """
    if not brand_config:
        return None
    raw = brand_config.get("radius_expansion_centers")
    if not isinstance(raw, list) or not raw:
        return None
    out: List[Tuple[str, float, float]] = []
    for item in raw:
        try:
            if isinstance(item, dict):
                name = (
                    item.get("name")
                    or item.get("label")
                    or item.get("city")
                    or "center"
                )
                lat = float(item["lat"])
                lng = item.get("lng")
                if lng is None:
                    lng = item.get("lon")
                if lng is None:
                    lng = item.get("long")
                out.append((str(name), lat, float(lng)))
            elif isinstance(item, (list, tuple)) and len(item) >= 3:
                out.append((str(item[0]), float(item[1]), float(item[2])))
        except (TypeError, ValueError, KeyError):
            continue
    return out if out else None


def _radius_page_fingerprint(entities: List[Any]) -> Tuple[str, ...]:
    """Stable fingerprint for one API page — detects repeated pages when offset is ignored."""
    keys: List[str] = []
    for e in entities:
        if not isinstance(e, dict):
            continue
        pid = e.get("ID") or e.get("id")
        prof = e.get("profile")
        if pid is None and isinstance(prof, dict):
            meta = prof.get("meta")
            if isinstance(meta, dict):
                pid = meta.get("id")
        keys.append(str(pid) if pid is not None else "")
    return tuple(sorted(keys))


def scrape_radius_expansion(
    url: str,
    url_params: Dict,
    region: str = "world",
    brand_config: Optional[Dict] = None,
) -> List[Dict]:
    """Expand radius-based API using multiple center points worldwide."""
    import requests

    req_headers = _radius_expansion_request_headers(brand_config)
    config_centers = _parse_radius_expansion_centers(brand_config)
    loop_delay = 0.3
    if brand_config and brand_config.get("radius_expansion_delay_seconds") is not None:
        try:
            loop_delay = max(0.0, float(brand_config["radius_expansion_delay_seconds"]))
        except (TypeError, ValueError):
            loop_delay = 0.3

    print(f"🌍 Radius-based API detected - expanding to {region} using multiple center points")

    # Major cities worldwide for maximum coverage
    # These are strategically placed to cover all continents and ensure complete coverage
    major_cities = [
        # Europe (expanded for better coverage)
        ("Paris", 48.8566, 2.3522),
        ("London", 51.5074, -0.1278),
        ("Berlin", 52.5200, 13.4050),
        ("Madrid", 40.4168, -3.7038),
        ("Rome", 41.9028, 12.4964),
        ("Amsterdam", 52.3676, 4.9041),
        ("Vienna", 48.2082, 16.3738),
        ("Zurich", 47.3769, 8.5417),
        ("Moscow", 55.7558, 37.6173),
        ("Stockholm", 59.3293, 18.0686),
        ("Copenhagen", 55.6761, 12.5683),
        ("Warsaw", 52.2297, 21.0122),
        ("Prague", 50.0755, 14.4378),
        ("Athens", 37.9838, 23.7275),
        ("Lisbon", 38.7223, -9.1393),
        ("Dublin", 53.3498, -6.2603),
        ("Brussels", 50.8503, 4.3517),
        ("Oslo", 59.9139, 10.7522),
        ("Helsinki", 60.1699, 24.9384),
        
        # Americas (expanded for better coverage)
        ("New York", 40.7128, -74.0060),
        ("Los Angeles", 34.0522, -118.2437),
        ("Chicago", 41.8781, -87.6298),
        ("San Francisco", 37.7749, -122.4194),
        ("Houston", 29.7604, -95.3698),
        ("Toronto", 43.6532, -79.3832),
        ("Vancouver", 49.2827, -123.1207),
        ("Mexico City", 19.4326, -99.1332),
        ("São Paulo", -23.5505, -46.6333),
        ("Rio de Janeiro", -22.9068, -43.1729),
        ("Buenos Aires", -34.6037, -58.3816),
        ("Miami", 25.7617, -80.1918),
        ("Bogotá", 4.7110, -74.0721),
        ("Lima", -12.0464, -77.0428),
        ("Santiago", -33.4489, -70.6693),
        
        # Asia-Pacific (expanded for better coverage)
        ("Tokyo", 35.6762, 139.6503),
        ("Shanghai", 31.2304, 121.4737),
        ("Beijing", 39.9042, 116.4074),
        ("Hong Kong", 22.3193, 114.1694),
        ("Singapore", 1.3521, 103.8198),
        ("Bangkok", 13.7563, 100.5018),
        ("Kuala Lumpur", 3.1390, 101.6869),
        ("Jakarta", -6.2088, 106.8456),
        ("Manila", 14.5995, 120.9842),
        ("Mumbai", 19.0760, 72.8777),
        ("Delhi", 28.6139, 77.2090),
        ("Bangalore", 12.9716, 77.5946),
        ("Dubai", 25.2048, 55.2708),
        ("Sydney", -33.8688, 151.2093),
        ("Melbourne", -37.8136, 144.9631),
        ("Seoul", 37.5665, 126.9780),
        ("Taipei", 25.0330, 121.5654),
        
        # Middle East & Africa (expanded)
        ("Riyadh", 24.7136, 46.6753),
        ("Jeddah", 21.4858, 39.1925),
        ("Cairo", 30.0444, 31.2357),
        ("Johannesburg", -26.2041, 28.0473),
        ("Cape Town", -33.9249, 18.4241),
        ("Lagos", 6.5244, 3.3792),
        ("Nairobi", -1.2921, 36.8219),
        ("Tel Aviv", 32.0853, 34.7818),
        ("Istanbul", 41.0082, 28.9784),
    ]

    if config_centers:
        major_cities = config_centers
        print(f"   📍 Using {len(major_cities)} center point(s) from brand config (radius_expansion_centers)")
    else:
        # Filter by region if specified
        if region == "north_america":
            major_cities = [c for c in major_cities if c[0] in ["New York", "Los Angeles", "Chicago", "Toronto", "Miami", "Mexico City"]]
        elif region == "europe":
            major_cities = [c for c in major_cities if c[0] in ["Paris", "London", "Berlin", "Madrid", "Rome", "Amsterdam", "Vienna", "Zurich", "Moscow"]]
        elif region == "asia":
            major_cities = [c for c in major_cities if c[0] in ["Tokyo", "Shanghai", "Hong Kong", "Singapore", "Bangkok", "Mumbai", "Dubai", "Seoul", "Taipei"]]

    # Detect center-point format from input URL (Yext: q=lat,lng vs SFCC: lat/long)
    if 'lat' in url_params and ('long' in url_params or 'lng' in url_params):
        center_format = 'lat_long'
        lat_key = 'lat'
        lng_key = 'long' if 'long' in url_params else 'lng'
    elif 'latitude' in url_params and ('longitude' in url_params or 'lng' in url_params):
        center_format = 'lat_long'
        lat_key = 'latitude'
        lng_key = 'longitude' if 'longitude' in url_params else 'lng'
    elif brand_config and brand_config.get("radius_expansion_centers"):
        center_format = 'lat_long'
        lat_key = str(brand_config.get("radius_lat_param", "lat"))
        lng_key = str(brand_config.get("radius_lng_param", "long"))
    else:
        center_format = 'q'

    path_lower = urlparse(url.split('?')[0]).path.lower()
    is_sfcc_stores = '/dw/shop/' in path_lower and 'stores' in path_lower

    # Detect radius key and value from input URL (SFCC / Demandware uses max_distance + distance_unit)
    radius_key = 'r'
    radius = '2000'
    for _rk in ('max_distance', 'maxdistance', 'radius', 'r', 'distance'):
        if _rk in url_params:
            radius_key = _rk
            _rv = url_params[_rk]
            radius = _rv[0] if isinstance(_rv, list) else _rv
            break
    if brand_config and brand_config.get("radius_expansion_radius") is not None:
        _rr = brand_config.get("radius_expansion_radius")
        radius = str(_rr).strip() if _rr is not None else radius
    if radius_key in ('max_distance', 'maxdistance'):
        try:
            _rv_num = float(radius)
        except (TypeError, ValueError):
            _rv_num = 0.0
        if _rv_num < 500:
            radius = '8000'
            print(
                f"   💡 {radius_key}={_rv_num} is small (viewport-sized); "
                f"using {radius} for worldwide multi-center coverage"
            )

    # Pagination: Yext-style (q=lat,lng) APIs typically need per/offset on every request,
    # even when the captured URL omitted them. SFCC / lat+long endpoints usually return one
    # full page per call — do not send synthetic per/offset there (can break or confuse the API).
    if center_format == 'q':
        per_key = next((k for k in ('per', 'limit', 'per_page') if k in url_params), 'per')
        _per_raw = url_params.get(per_key, '50')
        per = _per_raw[0] if isinstance(_per_raw, list) else _per_raw
        offset_key = 'offset'
    else:
        per_key = next((k for k in ('per', 'limit', 'per_page') if k in url_params), None)
        offset_key = 'offset' if (per_key or 'offset' in url_params) else None
        per = url_params.get(per_key, '50') if per_key else None
        if isinstance(per, list):
            per = per[0]

    lang = url_params.get('l') or url_params.get('lang')
    if center_format == 'q' and not lang:
        lang = 'en'

    # Strip location, radius, and pagination keys so we can add our own
    _strip = {
        'q', 'qp', 'lat', 'long', 'lng', 'latitude', 'longitude',
        'r', 'radius', 'distance', 'max_distance', 'maxdistance', 'start',
    }
    if center_format == 'lat_long':
        _strip.add(lat_key)
        _strip.add(lng_key)
    if offset_key:
        _strip.add(offset_key)
    if per_key:
        _strip.add(per_key)
    base_params = {k: v for k, v in url_params.items() if k not in _strip}

    use_sfcc_start_count = center_format == 'lat_long' and (
        is_sfcc_stores or 'count' in url_params
    )
    page_sz = 100
    if use_sfcc_start_count:
        _craw = url_params.get('count', '100')
        page_sz = int(_craw[0] if isinstance(_craw, list) else _craw)
        page_sz = max(1, min(page_sz, 200))

    all_stores = []
    seen_ids = set()

    print(f"   Using {len(major_cities)} center points with {radius_key}={radius}")
    if use_sfcc_start_count:
        print(f"   SFCC-style pagination: count={page_sz}, iterating start=0,{page_sz},...")
    print(f"   Starting multi-point radius expansion...")

    for i, (city_name, city_lat, city_lng) in enumerate(major_cities, 1):
        print(f"   [{i}/{len(major_cities)}] {city_name}...", end=" ", flush=True)

        offset = 0
        start_off = 0
        page = 1
        stores_from_city = []
        prev_page_fp: Optional[Tuple[str, ...]] = None
        empty_full_pages = 0

        while True:
            params = base_params.copy()
            if center_format == 'lat_long':
                params[lat_key] = str(city_lat)
                params[lng_key] = str(city_lng)
            else:
                params['q'] = f"{city_lat},{city_lng}"
            params[radius_key] = radius
            if use_sfcc_start_count:
                params['count'] = str(page_sz)
                params['start'] = str(start_off)
            elif per_key:
                params[per_key] = per
                params[offset_key] = str(offset)
            if lang:
                params['l'] = lang

            try:
                response = requests.get(
                    url.split('?')[0], params=params, timeout=15, headers=req_headers
                )
                response.raise_for_status()
                data = response.json()

                if isinstance(data, list):
                    entities = data
                elif isinstance(data, dict):
                    response_data = data.get('response', data)
                    entities = next(
                        (
                            response_data[k]
                            for k in (
                                'entities', 'data', 'results', 'stores',
                                'locations', 'dealers', 'retailers', 'items', 'points',
                            )
                            if isinstance(response_data.get(k), list) and response_data[k]
                        ),
                        [],
                    )
                else:
                    entities = []

                if not entities:
                    break

                new_stores = []
                for store in entities:
                    if not isinstance(store, dict):
                        continue

                    profile = store.get('profile', {}) if isinstance(store.get('profile'), dict) else {}

                    store_id = store.get('ID') or store.get('id')
                    if not store_id and profile:
                        meta = profile.get('meta', {})
                        if isinstance(meta, dict):
                            store_id = meta.get('id')

                    if not store_id:
                        name = store.get('name') or (profile.get('name') if profile else '')
                        addr = ''
                        city_val = ''
                        if profile:
                            addr_obj = profile.get('address', {})
                            if isinstance(addr_obj, dict):
                                addr = addr_obj.get('line1', '')
                                city_val = addr_obj.get('city', '')
                        if not addr:
                            addr = store.get('address1', '') or store.get('address', '')
                        if not city_val:
                            city_val = store.get('city', city_val)
                        name_n = str(name).lower().strip() if name else ''
                        addr_n = str(addr).lower().strip() if addr else ''
                        city_n = str(city_val).lower().strip() if city_val else ''
                        if name_n and addr_n:
                            store_id = f"{name_n}|{addr_n}|{city_n}"

                    if not store_id:
                        name = store.get('name') or (profile.get('name') if profile else '')
                        geo_lat = store.get('latitude')
                        geo_lng = store.get('longitude')
                        if geo_lat is None and profile:
                            geo = profile.get('geocodedCoordinate', {})
                            if isinstance(geo, dict):
                                geo_lat = geo.get('lat')
                                geo_lng = geo.get('long')
                        if name and geo_lat is not None and geo_lng is not None:
                            store_id = f"{str(name).lower().strip()}|{geo_lat}|{geo_lng}"

                    if store_id:
                        if store_id not in seen_ids:
                            seen_ids.add(store_id)
                            new_stores.append(store)
                    else:
                        log_debug(f"Store without ID found: {store.get('name', 'Unknown')}", "WARN")
                        new_stores.append(store)

                page_fp = _radius_page_fingerprint(entities)
                if prev_page_fp is not None and page_fp and page_fp == prev_page_fp:
                    log_debug(
                        f"Pagination stuck (same page repeated) for {city_name} — "
                        "server likely ignores offset; stopping this center",
                        "WARN",
                    )
                    break
                prev_page_fp = page_fp

                if use_sfcc_start_count:
                    full_page = len(entities) >= page_sz
                else:
                    full_page = per is not None and len(entities) >= int(per)
                if not new_stores:
                    if full_page:
                        empty_full_pages += 1
                        if empty_full_pages >= 2:
                            log_debug(
                                f"No new stores in {empty_full_pages} full pages for {city_name} — "
                                "offset may be unsupported or this center adds nothing; stopping",
                                "WARN",
                            )
                            break
                    else:
                        stores_from_city.extend(new_stores)
                        break
                else:
                    empty_full_pages = 0

                stores_from_city.extend(new_stores)

                if use_sfcc_start_count:
                    total_api = None
                    if isinstance(data, dict):
                        total_api = data.get('total')
                        if total_api is None and isinstance(data.get('response'), dict):
                            total_api = data['response'].get('total')
                    if not entities:
                        break
                    if total_api is not None:
                        try:
                            if start_off + len(entities) >= int(total_api):
                                break
                        except (TypeError, ValueError):
                            pass
                    if len(entities) < page_sz:
                        break
                    start_off += page_sz
                    page += 1
                    if page > 500:
                        log_debug(f"Reached page limit (500) for {city_name}, stopping", "WARN")
                        break
                    time.sleep(loop_delay)
                    continue

                count = data.get('response', {}).get('count', len(entities)) if isinstance(data, dict) else len(entities)
                if per is None or len(entities) < int(per):
                    break
                if count and len(stores_from_city) >= int(count):
                    break

                offset += int(per)
                page += 1

                if page > 100:
                    log_debug(f"Reached page limit (100) for {city_name}, stopping", "WARN")
                    break

                time.sleep(loop_delay)
            except Exception as e:
                log_debug(f"Error fetching from {city_name}: {e}", "WARN")
                break
        
        all_stores.extend(stores_from_city)
        print(f"+{len(stores_from_city)} stores (total: {len(all_stores)})")
    
    print(f"   ✅ Multi-point expansion complete: {len(all_stores)} unique stores")
    return all_stores


def scrape_viewport_expansion(
    url: str,
    url_params: Dict,
    region: str = "world",
    brand_config: Optional[Dict] = None,
) -> List[Dict]:
    """Expand viewport-based API using grid scraping"""
    from viewport_grid import scrape_viewport_api, get_region_preset

    print(f"🗺️  Viewport API detected - expanding to {region}")

    viewport_params = {
        "northEastLat": "northEastLat",
        "northEastLng": "northEastLng",
        "southWestLat": "southWestLat",
        "southWestLng": "southWestLng",
    }

    additional_params = {
        k: v
        for k, v in url_params.items()
        if k
        not in [
            "northEastLat",
            "northEastLng",
            "southWestLat",
            "southWestLng",
            "lat",
            "lng",
        ]
    }

    grid_size = DEFAULT_VIEWPORT_GRID_SIZE
    if brand_config:
        raw_gs = brand_config.get("viewport_grid_size")
        if raw_gs is not None and str(raw_gs).strip() != "":
            try:
                gs = int(raw_gs)
                if 1 <= gs <= 90:
                    grid_size = gs
            except (TypeError, ValueError):
                pass

    req_headers = _get_custom_headers(brand_config)

    grid_type = "world" if region == "world" else "focused"
    focus_region = None if region == "world" else get_region_preset(region)

    stores = scrape_viewport_api(
        base_url=url.split("?")[0],
        viewport_params=viewport_params,
        grid_type=grid_type,
        grid_size=grid_size,
        data_path="",
        additional_params=additional_params,
        delay_between_requests=DEFAULT_DELAY_BETWEEN_REQUESTS,
        focus_region=focus_region,
        request_headers=req_headers,
    )

    return stores


def scrape_country_expansion(url: str, url_params: Dict, region: str = "world", countries_dict: Dict = None, brand_config: Dict = None, use_watch_countries: bool = False) -> List[Dict]:
    """Expand country-filter API by iterating through countries, with optional pagination support"""
    import requests
    
    # Try to load comprehensive watch store countries list
    watch_countries_file = os.path.join(os.path.dirname(__file__), "watch_store_countries.json")
    watch_countries_data = None
    if os.path.exists(watch_countries_file):
        try:
            with open(watch_countries_file, 'r') as f:
                watch_countries_data = json.load(f)
        except (OSError, json.JSONDecodeError):
            pass
    
    # Priority: custom countries > watch_store_countries > fallback
    # Use countries from brand config if provided (and not using watch_store_countries)
    if countries_dict and not use_watch_countries:
        countries_list = list(countries_dict.keys())
        country_names = countries_dict
        print(f"🌍 Country filter detected - iterating {len(countries_list)} countries (from brand config)")
    elif use_watch_countries and watch_countries_data and watch_countries_data.get("countries"):
        # Use comprehensive watch store countries list
        all_watch_countries = watch_countries_data["countries"]
        countries_list = list(all_watch_countries.keys())
        country_names = all_watch_countries
        
        # Filter by region if specified
        if region != "world" and watch_countries_data.get("regions") and region in watch_countries_data["regions"]:
            region_codes = watch_countries_data["regions"][region]
            countries_list = [code for code in countries_list if code in region_codes]
            country_names = {code: all_watch_countries[code] for code in countries_list if code in all_watch_countries}
        
        print(f"🌍 Country filter detected - iterating {len(countries_list)} countries (from watch_store_countries.json)")
    else:
        # Fallback to hardcoded list
        all_countries = [
            "US", "CA", "GB", "FR", "DE", "IT", "ES", "CH", "AT", "BE", "NL", "SE", "NO", "DK", "FI",
            "IE", "PT", "GR", "PL", "CZ", "HU", "RO", "BG", "HR", "SI", "SK", "EE", "LV", "LT",
            "JP", "CN", "KR", "TW", "HK", "SG", "MY", "TH", "ID", "PH", "VN", "IN", "AU", "NZ",
            "AE", "SA", "QA", "KW", "BH", "OM", "IL", "TR", "ZA", "EG", "BR", "MX", "AR", "CL", "CO"
        ]
        
        if region == "north_america":
            countries_list = ["US", "CA", "MX"]
        elif region == "europe":
            countries_list = ["GB", "FR", "DE", "IT", "ES", "CH", "AT", "BE", "NL", "SE", "NO", "DK"]
        else:
            countries_list = all_countries
        
        country_names = {code: code for code in countries_list}
        print(f"🌍 Country filter detected - iterating {len(countries_list)} countries")
    
    country_param = None
    qp_param = None
    for key in url_params.keys():
        if "country" in key.lower():
            country_param = key
        if key.lower() == "qp":
            qp_param = key
    if not country_param:
        country_param = "country"

    # APIs that need their own country IDs (numeric, UUID, etc.) — map ISO codes via country_id_map
    # Activates whenever country_id_map is present, regardless of the URL param name.
    country_id_map = brand_config.get("country_id_map", {}) if brand_config else {}
    if country_id_map:
        countries_list = [c for c in countries_list if c in country_id_map]
        country_names = {c: country_names.get(c, c) for c in countries_list}
        print(f"   Using country_id_map: {len(countries_list)} countries (ISO->internal id)")
    
    # Check if pagination is needed (has offset or per parameter)
    has_pagination = "offset" in url_params or "per" in url_params or "per_page" in url_params
    per_page = int(url_params.get("per", url_params.get("per_page", 50)))
    
    all_stores = []
    seen_ids = set()
    
    for i, country_code in enumerate(countries_list, 1):
        country_name = country_names.get(country_code, country_code)
        param_value = country_id_map.get(country_code, country_code) if country_id_map else country_code

        # Handle pagination for this country
        if has_pagination:
            offset = 0
            country_stores = []
            
            while True:
                params = url_params.copy()
                params[country_param] = param_value
                if qp_param:
                    params[qp_param] = country_name
                if "offset" in url_params:
                    params["offset"] = str(offset)
                
                try:
                    headers = _country_expansion_request_headers(brand_config)
                    response = requests.get(url.split('?')[0], params=params, timeout=30, headers=headers)
                    response.raise_for_status()
                    data = response.json()
                    
                    # Extract stores using data_path from brand_config if available
                    stores = []
                    if brand_config and brand_config.get("data_path"):
                        data_path = brand_config["data_path"].split(".")
                        current = data
                        for key in data_path:
                            if isinstance(current, dict):
                                current = current.get(key)
                            else:
                                current = None
                                break
                        if isinstance(current, list):
                            stores = current
                    else:
                        # Fallback: try common paths
                        if isinstance(data, list):
                            stores = data
                        elif isinstance(data, dict):
                            response_data = data.get('response', data)
                            stores = response_data.get('entities', []) or response_data.get('results', []) or response_data.get('data', [])
                    
                    if not stores:
                        break
                    
                    country_stores.extend(stores)
                    
                    # Check if we've reached the end
                    total_count = data.get('response', {}).get('count', 0) if isinstance(data, dict) else 0
                    if len(stores) < per_page or (total_count > 0 and len(country_stores) >= total_count):
                        break
                    
                    offset += per_page
                    time.sleep(0.5)  # Rate limiting
                    
                except Exception as e:
                    log_debug(f"Error fetching {country_code} offset {offset}: {e}", "WARN")
                    break
            
            # Deduplicate stores for this country
            inject_country_field = (brand_config or {}).get("inject_country_field")
            new_stores = 0
            for store in country_stores:
                store_id = None
                if isinstance(store, dict):
                    if inject_country_field:
                        store[inject_country_field] = country_name
                    # Try multiple ID extraction strategies
                    profile = store.get('profile', {})
                    if isinstance(profile, dict):
                        meta = profile.get('meta', {})
                        if isinstance(meta, dict):
                            store_id = meta.get('id')
                    if not store_id:
                        store_id = store.get('id') or store.get('uid') or store.get('entityId')
                    if not store_id:
                        # Use name + address as fallback
                        name = store.get('name') or (profile.get('name') if isinstance(profile, dict) else '')
                        addr = ''
                        if isinstance(profile, dict):
                            addr_obj = profile.get('address', {})
                            if isinstance(addr_obj, dict):
                                addr = addr_obj.get('line1', '')
                        if name and addr:
                            store_id = f"{name}|{addr}"
                
                if store_id and store_id not in seen_ids:
                    all_stores.append(store)
                    seen_ids.add(store_id)
                    new_stores += 1
            
            if new_stores > 0:
                print(f"  [{i}/{len(countries_list)}] {country_code}: +{new_stores} stores (total: {len(all_stores)})")
        else:
            # No pagination - single request per country
            params = url_params.copy()
            params[country_param] = param_value
            if qp_param:
                params[qp_param] = country_name
            
            try:
                headers = _country_expansion_request_headers(brand_config)
                response = requests.get(url.split('?')[0], params=params, timeout=30, headers=headers)
                response.raise_for_status()
                data = response.json()
                
                # Extract stores
                stores = []
                if brand_config and brand_config.get("data_path"):
                    data_path = brand_config["data_path"].split(".")
                    current = data
                    for key in data_path:
                        if isinstance(current, dict):
                            current = current.get(key)
                        else:
                            current = None
                            break
                    if isinstance(current, list):
                        stores = current
                else:
                    if isinstance(data, list):
                        stores = data
                    elif isinstance(data, dict):
                        response_data = data.get('response', data)
                        stores = response_data.get('entities', []) or response_data.get('results', []) or response_data.get('data', [])
                
                # Inject iterated country into each store record so field_mapping can read it
                # (used by APIs that return only an internal country id, e.g. Seiko UUIDs)
                inject_country_field = (brand_config or {}).get("inject_country_field")
                new_stores = 0
                for store in stores:
                    if inject_country_field and isinstance(store, dict):
                        store[inject_country_field] = country_name
                    store_id = store.get("id") or store.get("store_id") or str(store)
                    if store_id not in seen_ids:
                        all_stores.append(store)
                        seen_ids.add(store_id)
                        new_stores += 1

                if new_stores > 0:
                    print(f"  [{i}/{len(countries_list)}] {country_code}: +{new_stores} stores (total: {len(all_stores)})")

                time.sleep(0.3)

            except Exception as e:
                log_debug(f"Error fetching {country_code}: {e}", "WARN")
                continue

    return all_stores


def _get_nested(store: Dict, field_path: str) -> Any:
    """Resolve a dot-notation path inside a raw store dict (e.g. 'extra_fields.Rank')."""
    value: Any = store
    for part in field_path.split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


def apply_row_filters(stores: List[Dict], brand_config: Optional[Dict]) -> List[Dict]:
    """Filter raw store records using the ``row_filters`` list from brand config.

    Returns the original list unchanged when ``row_filters`` is absent or empty,
    so all other brands are completely unaffected.

    Each filter entry is a dict with:
      - ``field``  : dot-notation path into the raw store dict (e.g. ``"extra_fields.Rank"``)
      - ``op``     : one of ``eq`` (default), ``in``, ``not_in``, ``contains``
      - ``value``  : single value (used by ``eq`` / ``contains``)
      - ``values`` : list of values (used by ``in`` / ``not_in``)

    All filters are ANDed together; a store must pass every filter to be kept.

    Example brand config fragment::

        "row_filters": [
            { "field": "extra_fields.Rank", "op": "in", "values": ["2"] }
        ]
    """
    if not brand_config:
        return stores
    filters = brand_config.get("row_filters")
    if not filters:
        return stores

    before = len(stores)
    result = []
    for store in stores:
        keep = True
        for f in filters:
            field = f.get("field", "")
            op = f.get("op", "eq")
            raw_val = _get_nested(store, field)
            val_str = str(raw_val) if raw_val is not None else ""

            if op == "eq":
                if val_str != str(f.get("value", "")):
                    keep = False
                    break
            elif op == "in":
                if val_str not in [str(v) for v in f.get("values", [])]:
                    keep = False
                    break
            elif op == "not_in":
                if val_str in [str(v) for v in f.get("values", [])]:
                    keep = False
                    break
            elif op == "contains":
                if str(f.get("value", "")) not in val_str:
                    keep = False
                    break
        if keep:
            result.append(store)

    removed = before - len(result)
    if removed:
        log_debug(f"row_filters removed {removed} of {before} stores ({len(result)} kept)", "INFO")
        print(f"   🔍 row_filters: kept {len(result)} of {before} stores ({removed} removed)")
    return result


def scrape_geohash_prefix_expansion(base_url: str, brand_config: Optional[Dict] = None) -> List[Dict]:
    """Fetch stores sharded by geohash prefix (e.g. Casio /api/points/{prefix}).

    The API root returns a ``total`` count but an empty ``items`` list.  Each
    two-character geohash prefix sub-URL returns ``{"items": [...]}`` containing
    only the stores whose ``geo_hash`` field starts with that prefix.

    Strategy:
    1. Fetch root once to read the expected total.
    2. Enumerate all prefixes of ``prefix_length`` (default 2) over the standard
       geohash alphabet (32 chars).
    3. GET ``{base_url}/{prefix}``, extract ``items`` (or configured data_path).
    4. Dedupe by ``id`` and ``key`` fields.
    5. Warn if final count does not match root total.
    """
    import requests
    import itertools

    cfg = brand_config.get("geohash_prefix_expansion", {}) if brand_config else {}
    prefix_length: int = int(cfg.get("prefix_length", 2))
    alphabet: str = cfg.get("alphabet", "0123456789bcdefghjkmnpqrstuvwxyz")
    items_key: str = cfg.get("items_key", "items")
    delay: float = float(cfg.get("delay", 0.15))

    base_url = base_url.rstrip("/")
    custom_headers = _get_custom_headers(brand_config)
    request_headers = {"User-Agent": "Mozilla/5.0"}
    if custom_headers:
        request_headers.update(custom_headers)

    # Fetch root once to get the expected total for validation
    root_total: Optional[int] = None
    try:
        resp = requests.get(base_url, headers=request_headers, timeout=15)
        resp.raise_for_status()
        root_data = resp.json()
        if isinstance(root_data, dict):
            root_total = root_data.get("total")
        if root_total:
            print(f"🌍 Geohash prefix expansion — root total: {root_total} stores")
        else:
            print("🌍 Geohash prefix expansion — root total unknown")
    except Exception as e:
        log_debug(f"Could not fetch root for total count: {e}", "WARN")

    total_prefixes = len(alphabet) ** prefix_length
    print(f"   Fetching {total_prefixes} prefix buckets (length={prefix_length})…")

    seen: dict = {}  # keyed by unique store id to dedupe
    errors = 0

    for chars in itertools.product(alphabet, repeat=prefix_length):
        prefix = "".join(chars)
        url = f"{base_url}/{prefix}"
        try:
            resp = requests.get(url, headers=request_headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            items = []
            if isinstance(data, dict):
                items = data.get(items_key, [])
            elif isinstance(data, list):
                items = data
            for store in items:
                if not isinstance(store, dict):
                    continue
                uid = store.get("id") or store.get("key") or store.get("ID")
                key = str(uid) if uid is not None else f"{store.get('latitude','')},{store.get('longitude','')},{store.get('name','')}"
                if key not in seen:
                    seen[key] = store
            time.sleep(delay)
        except Exception as e:
            log_debug(f"Geohash prefix error for {prefix}: {e}", "WARN")
            errors += 1
            continue

    all_stores = list(seen.values())
    log_debug(f"Geohash expansion complete | {len(all_stores)} unique stores | {errors} errors", "SUCCESS")
    print(f"   ✅ {len(all_stores)} unique stores collected across {total_prefixes} buckets")

    if root_total and len(all_stores) != root_total:
        diff = root_total - len(all_stores)
        if diff > 0:
            log_debug(
                f"Store count mismatch: got {len(all_stores)}, expected {root_total} ({diff} missing). "
                "Consider increasing prefix_length if buckets are being truncated.",
                "WARN",
            )
            print(f"   ⚠️  {diff} stores may be missing — root total is {root_total}. Consider prefix_length=3 if counts diverge.")
        else:
            log_debug(f"Store count {len(all_stores)} slightly exceeds root total {root_total} (dupes removed from overlapping buckets)", "DEBUG")

    return all_stores


def scrape_post_per_country(base_url: str, brand_config: Optional[Dict] = None) -> List[Dict]:
    """POST to a single endpoint once per country, with a JSON body template.

    Strategy used by APIs like Zenith's storeLocator: one URL, POST method,
    body ``{"country": "US"}``. The endpoint returns all stores for that
    country in a single response (no pagination). We iterate the brand's
    country list (or the global watch_store_countries list) and POST each.

    Brand config keys (under ``post_per_country``):
      - ``body_template`` (dict, required): JSON body to POST. Any string value
        equal to ``"{country}"`` is replaced with the current country code.
      - ``data_path`` (str, optional): dot-path into the response to reach the
        store list (e.g. ``"result"``). If omitted, common keys are tried.
      - ``delay`` (float, default 0.2): seconds between requests.
      - ``countries`` (list[str], optional): explicit country code list. If
        omitted, uses ``watch_store_countries.json``'s ``countries`` dict.
      - ``stop_on_empty`` (bool, default False): if True, stop after N
        consecutive empty country responses (currently unused, reserved).
    """
    import requests
    import copy

    cfg = brand_config.get("post_per_country", {}) if brand_config else {}
    body_template = cfg.get("body_template") or {"country": "{country}"}
    data_path = cfg.get("data_path") or brand_config.get("data_path", "") if brand_config else ""
    delay = float(cfg.get("delay", 0.2))

    # Resolve country list
    countries: List[str] = []
    if isinstance(cfg.get("countries"), list) and cfg["countries"]:
        countries = list(cfg["countries"])
    else:
        try:
            wsc_path = os.path.join(os.path.dirname(__file__), "watch_store_countries.json")
            with open(wsc_path, "r", encoding="utf-8") as f:
                wsc = json.load(f)
            countries = list((wsc.get("countries") or {}).keys())
        except Exception as e:
            log_debug(f"Could not load watch_store_countries.json: {e}", "WARN")
            countries = ["US"]

    custom_headers = _get_custom_headers(brand_config)
    request_headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    if custom_headers:
        request_headers.update(custom_headers)

    def _interpolate(obj, country_code):
        if isinstance(obj, dict):
            return {k: _interpolate(v, country_code) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_interpolate(v, country_code) for v in obj]
        if isinstance(obj, str):
            return obj.replace("{country}", country_code)
        return obj

    def _extract_items(data):
        # Walk data_path if provided
        if data_path:
            cur = data
            for part in data_path.split("."):
                if isinstance(cur, dict):
                    cur = cur.get(part)
                else:
                    cur = None
                    break
            if isinstance(cur, list):
                return cur
        # Fallback: try common keys
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for k in ("result", "results", "data", "stores", "items", "locations", "retailers", "dealers"):
                v = data.get(k)
                if isinstance(v, list):
                    return v
        return []

    print(f"🌍 POST-per-country expansion — {len(countries)} countries")
    seen: dict = {}
    errors = 0

    for i, country_code in enumerate(countries, 1):
        body = _interpolate(copy.deepcopy(body_template), country_code)
        try:
            resp = requests.post(base_url, headers=request_headers, json=body, timeout=20)
            resp.raise_for_status()
            data = resp.json()
            items = _extract_items(data)
            new_count = 0
            for store in items:
                if not isinstance(store, dict):
                    continue
                uid = (
                    store.get("id")
                    or store.get("ID")
                    or store.get("seller_code")
                    or store.get("code")
                    or f"{store.get('name','')}|{country_code}|{json.dumps(store.get('address',''), sort_keys=True, default=str)[:80]}"
                )
                key = str(uid)
                if key not in seen:
                    seen[key] = store
                    new_count += 1
            if i % 10 == 0 or new_count > 0:
                print(f"   [{i}/{len(countries)}] {country_code}: +{new_count} (total {len(seen)})")
            time.sleep(delay)
        except Exception as e:
            log_debug(f"POST-per-country error for {country_code}: {e}", "WARN")
            errors += 1
            continue

    all_stores = list(seen.values())
    log_debug(f"POST-per-country complete | {len(all_stores)} unique stores | {errors} errors", "SUCCESS")
    print(f"   ✅ {len(all_stores)} unique stores collected across {len(countries)} countries")
    return all_stores


def _flatten_grouped_stores_list(
    data: Dict[str, Any], brand_config: Optional[Dict]
) -> Optional[List[Dict]]:
    """
    Walk ``flatten_grouped_stores.path`` to a list of group objects, then concatenate
    each group's ``list_key`` array (default ``retailers``) into one flat store list.
    Returns None if the option is not set or navigation fails (caller uses normal logic).
    """
    cfg = (brand_config or {}).get("flatten_grouped_stores")
    if not isinstance(cfg, dict):
        return None
    path = str(cfg.get("path", "")).strip()
    list_key = str(cfg.get("list_key", "retailers")).strip() or "retailers"
    if not path:
        return None
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = dict_get_ci(cur, part)
        if cur is None:
            return None
    if not isinstance(cur, list):
        return None
    out: List[Dict] = []
    for group in cur:
        if not isinstance(group, dict):
            continue
        chunk = dict_get_ci(group, list_key)
        if isinstance(chunk, list):
            for row in chunk:
                if isinstance(row, dict):
                    out.append(row)
    return out


def _extract_stores_from_json_for_brand(
    data: Any, brand_config: Optional[Dict] = None
) -> List[Dict]:
    """
    Resolve the store list from a JSON response using data_path (if set) and the
    same fallbacks as scrape_single_call / country expansion.
    """
    stores: List[Dict] = []
    if isinstance(data, dict) and brand_config:
        grouped = _flatten_grouped_stores_list(data, brand_config)
        if grouped is not None:
            return grouped
    if isinstance(data, list):
        stores = [x for x in data if isinstance(x, dict)]
    elif isinstance(data, dict):
        if brand_config and brand_config.get("data_path"):
            parts = str(brand_config["data_path"]).strip().split(".")
            cur: Any = data
            for key in parts:
                if isinstance(cur, dict):
                    cur = dict_get_ci(cur, key)
                else:
                    cur = None
                    break
            if isinstance(cur, list):
                stores = [x for x in cur if isinstance(x, dict)]
        if not stores:
            nested_paths = [
                "response.entities",
                "response.data",
                "response.results",
                "response.stores",
                "data.stores",
                "data.results",
                "results.locations",
                "results.stores",
            ]
            for path in nested_paths:
                keys = path.split(".")
                value: Any = data
                ok = True
                for k in keys:
                    if isinstance(value, dict):
                        value = dict_get_ci(value, k)
                        if value is None:
                            ok = False
                            break
                    else:
                        ok = False
                        break
                if ok and isinstance(value, list):
                    stores = [x for x in value if isinstance(x, dict)]
                    break
        if not stores:
            for key in (
                "entities",
                "data",
                "results",
                "items",
                "stores",
                "hits",
                "locations",
                "dealers",
                "retailers",
            ):
                bucket = dict_get_ci(data, key)
                if isinstance(bucket, list):
                    stores = [x for x in bucket if isinstance(x, dict)]
                    break
    # Yext-style vertical search rows
    if stores and isinstance(stores[0], dict):
        first_wrap = dict_get_ci(stores[0], "data")
        if isinstance(first_wrap, dict) and all(
            isinstance(x, dict) and isinstance(dict_get_ci(x, "data"), dict)
            for x in stores
        ):
            stores = [dict_get_ci(x, "data") for x in stores]
    return stores


def _walk_json_path(obj: Any, path: str) -> Any:
    """Traverse dict/list via dot-separated path; numeric segments index into lists."""
    if obj is None:
        return None
    path = (path or "").strip()
    if not path:
        return obj
    cur: Any = obj
    for part in path.split("."):
        part = part.strip()
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = dict_get_ci(cur, part)
        elif isinstance(cur, list):
            try:
                idx = int(part)
            except ValueError:
                return None
            cur = cur[idx] if 0 <= idx < len(cur) else None
        else:
            return None
    return cur


def scrape_stores_by_api_country_catalog(brand_config: Dict) -> List[Dict]:
    """
    Fetch a JSON country catalog, then request store lists once per country ID.

    Brand config key ``stores_by_api_countries`` (object):
      - countries_url: GET JSON with a list of countries
      - countries_list_path: dot path to the array (default \"countries\")
      - country_id_field: field on each country row (default \"id\")
      - country_name_field: optional display name for logging / injection (default \"name\")
      - stores_url_template: URL with ``{country_id}`` placeholder
      - inject_country_name_field: if set, each store dict gets this key with the
        catalog country name (default \"_api_country_name\"; use \"\" to disable)
    """
    cfg = brand_config.get("stores_by_api_countries") or {}
    countries_url = str(cfg.get("countries_url", "")).strip()
    template = str(cfg.get("stores_url_template", "")).strip()
    list_path = str(cfg.get("countries_list_path", "countries")).strip() or "countries"
    id_field = str(cfg.get("country_id_field", "id")).strip() or "id"
    name_field = str(cfg.get("country_name_field", "name")).strip() or "name"
    inject_key = str(cfg.get("inject_country_name_field", "_api_country_name")).strip()

    if not countries_url:
        raise ValueError("stores_by_api_countries.countries_url is required")
    if "{country_id}" not in template:
        raise ValueError(
            "stores_by_api_countries.stores_url_template must contain {country_id}"
        )

    custom_headers = _get_custom_headers(brand_config)
    delay = 0.3
    if brand_config.get("radius_expansion_delay_seconds") is not None:
        try:
            delay = max(0.0, float(brand_config["radius_expansion_delay_seconds"]))
        except (TypeError, ValueError):
            delay = 0.3

    raw = fetch_data(countries_url, headers=custom_headers)
    if not isinstance(raw, dict):
        raise ValueError(
            f"Country catalog response must be a JSON object, got {type(raw).__name__}"
        )

    bucket = _walk_json_path(raw, list_path)
    if not isinstance(bucket, list):
        raise ValueError(
            f"Country list at path {list_path!r} must be a JSON array, got {type(bucket).__name__}"
        )

    pairs: List[Tuple[str, str]] = []
    for row in bucket:
        if not isinstance(row, dict):
            continue
        cid = row.get(id_field)
        if cid is None:
            cid = dict_get_ci(row, id_field)
        if cid is None or str(cid).strip() == "":
            continue
        cname_val = row.get(name_field)
        if cname_val is None:
            cname_val = dict_get_ci(row, name_field)
        cname_s = str(cname_val).strip() if cname_val is not None else ""
        pairs.append((str(cid), cname_s))

    if not pairs:
        log_debug("stores_by_api_countries: no country IDs in catalog", "WARN")
        return []

    seen_ids: set = set()
    all_stores: List[Dict] = []

    print(
        f"🌐 API country catalog: {len(pairs)} countries — fetching stores per country"
    )
    for i, (cid, cname) in enumerate(pairs):
        page_url = template.format(country_id=cid)
        try:
            data = fetch_data(page_url, headers=custom_headers)
            stores = _extract_stores_from_json_for_brand(data, brand_config)
            new_count = 0
            for store in stores:
                if inject_key and isinstance(store, dict) and cname:
                    store[inject_key] = cname
                sid = None
                if isinstance(store, dict):
                    sid = store.get("ID") or store.get("id") or store.get("storeID")
                    if not sid and isinstance(store.get("profile"), dict):
                        meta = store["profile"].get("meta") or {}
                        if isinstance(meta, dict):
                            sid = meta.get("id")
                    if sid is None:
                        sid = store.get("identifier")
                key = str(sid) if sid is not None else None
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)
                all_stores.append(store)
                new_count += 1
            label = cname or cid
            print(
                f"  Country {i + 1}/{len(pairs)} ({label}): +{new_count} stores "
                f"(total: {len(all_stores)})"
            )
        except Exception as e:
            log_debug(
                f"stores_by_api_countries error for country {cid}: {e}",
                "WARN",
            )
        time.sleep(delay)

    return all_stores


def scrape_pagination_fetch_urls(
    urls: List[str], brand_config: Optional[Dict] = None
) -> List[Dict]:
    """
    Fetch each URL (same JSON shape), extract store rows, merge and dedupe.
    Use when offset/per pagination is split across explicit endpoints or the API
    omits reliable total counts.
    """
    custom_headers = _get_custom_headers(brand_config)
    seen_ids: set = set()
    all_stores: List[Dict] = []
    delay = 0.3
    if brand_config and brand_config.get("radius_expansion_delay_seconds") is not None:
        try:
            delay = max(0.0, float(brand_config["radius_expansion_delay_seconds"]))
        except (TypeError, ValueError):
            delay = 0.3

    for i, page_url in enumerate(urls):
        page_url = (page_url or "").strip()
        if not page_url:
            continue
        try:
            data = fetch_data(page_url, headers=custom_headers)
            stores = _extract_stores_from_json_for_brand(data, brand_config)
            new_count = 0
            for store in stores:
                sid = None
                if isinstance(store, dict):
                    sid = store.get("ID") or store.get("id") or store.get("storeID")
                    if not sid and isinstance(store.get("profile"), dict):
                        meta = store["profile"].get("meta") or {}
                        if isinstance(meta, dict):
                            sid = meta.get("id")
                key = str(sid) if sid is not None else None
                if key and key in seen_ids:
                    continue
                if key:
                    seen_ids.add(key)
                all_stores.append(store)
                new_count += 1
            print(f"  URL {i + 1}/{len(urls)}: +{new_count} stores (total: {len(all_stores)})")
        except Exception as e:
            log_debug(f"pagination_fetch_urls error for {page_url[:80]}: {e}", "WARN")
        time.sleep(delay)
    return all_stores


def scrape_paginated(url: str, url_params: Dict, is_token_based: bool = False, custom_headers: Optional[Dict] = None) -> List[Dict]:
    """Expand paginated API by following all pages (supports both page numbers, tokens, and offset)"""
    import requests
    
    print("📄 Pagination detected - following pages")
    
    # Check if this is token-based pagination (pageToken) or number-based (page)
    # Can be passed explicitly or detected from URL params
    if not is_token_based:
        is_token_based = any("token" in k.lower() for k in url_params.keys())
    
    page_param = None
    limit_param = None
    token_param = None
    offset_param = None
    
    for key in url_params.keys():
        if "page" in key.lower() and "token" not in key.lower():
            page_param = key
        if "token" in key.lower():
            token_param = key
            is_token_based = True
        if "limit" in key.lower() or "per_page" in key.lower() or key.lower() == "per":
            limit_param = key
        if key.lower() == "offset":
            offset_param = key
    
    if not page_param and not is_token_based and not offset_param:
        page_param = "page"
    if not token_param and is_token_based:
        token_param = "pageToken"
    if not limit_param:
        limit_param = "limit"
    if not offset_param and "offset" in str(url_params):
        offset_param = "offset"
    
    if limit_param and limit_param not in url_params:
        url_params[limit_param] = 50  # Default limit
    
    # Prepare headers
    request_headers = {"User-Agent": "Mozilla/5.0"}
    if custom_headers:
        request_headers.update(custom_headers)
    
    all_stores = []
    page = 1
    page_token = None
    offset = 0
    max_pages = 1000
    seen_ids = set()  # For deduplication
    
    while page <= max_pages:
        params = url_params.copy()
        
        if is_token_based:
            # Token-based pagination
            if page_token:
                params[token_param] = page_token
            # Remove page number and offset params if they exist
            if page_param and page_param in params:
                del params[page_param]
            if offset_param and offset_param in params:
                del params[offset_param]
        elif offset_param:
            # Offset-based pagination
            params[offset_param] = offset
            # Remove page number param if it exists
            if page_param and page_param in params:
                del params[page_param]
        else:
            # Number-based pagination
            params[page_param] = page
            # Remove token and offset params if they exist
            if token_param and token_param in params:
                del params[token_param]
            if offset_param and offset_param in params:
                del params[offset_param]
        
        try:
            response = requests.get(url.split('?')[0], params=params, timeout=15, headers=request_headers)
            response.raise_for_status()
            data = response.json()
            
            # Extract stores from response (support nested paths like response.entities)
            stores = []
            if isinstance(data, list):
                stores = data
            elif isinstance(data, dict):
                # Try common keys for store arrays (including nested paths)
                for key_path in ["response.entities", "response.data", "response.results", 
                                "entities", "data", "results", "items", "stores", "locations"]:
                    keys = key_path.split('.')
                    value = data
                    for k in keys:
                        if isinstance(value, dict) and k in value:
                            value = value[k]
                        else:
                            break
                    else:
                        if isinstance(value, list):
                            stores = value
                            break
                else:
                    stores = []
            else:
                stores = []

            # Yext vertical search: each item is { "data": { entity }, "highlightedFields", "distance", ... }
            if stores and isinstance(stores[0], dict) and isinstance(stores[0].get("data"), dict):
                if all(isinstance(x, dict) and isinstance(x.get("data"), dict) for x in stores):
                    stores = [x["data"] for x in stores]
            
            if not stores:
                break
            
            # Deduplicate stores
            new_stores = []
            for store in stores:
                # Try to get unique ID (handle nested structures)
                store_id = None
                if isinstance(store, dict):
                    # Try various ID paths
                    profile = store.get('profile', {})
                    if isinstance(profile, dict):
                        meta = profile.get('meta', {})
                        if isinstance(meta, dict):
                            store_id = meta.get('id')
                    
                    if not store_id:
                        store_id = store.get('id')
                    
                    if not store_id:
                        meta = store.get('meta', {})
                        if isinstance(meta, dict):
                            store_id = meta.get('id')
                    
                    # Fallback to name + address for uniqueness
                    if not store_id:
                        name = store.get('name') or (profile.get('name') if isinstance(profile, dict) else '')
                        address = ''
                        if isinstance(profile, dict):
                            addr = profile.get('address', {})
                            if isinstance(addr, dict):
                                address = addr.get('line1', '')
                        elif isinstance(store.get('address'), dict):
                            address = store.get('address', {}).get('line1', '')
                        store_id = f"{name}|{address}"
                
                if store_id and store_id not in seen_ids:
                    seen_ids.add(store_id)
                    new_stores.append(store)
                elif not store_id:
                    # If no ID found, still add it (might be first occurrence)
                    new_stores.append(store)
            
            all_stores.extend(new_stores)
            print(f"  Page {page}: +{len(new_stores)} stores (total: {len(all_stores)})")
            
            # Check for pagination continuation
            if isinstance(data, dict):
                # Token-based: check for next token
                if is_token_based:
                    page_token = data.get(token_param) if token_param else data.get("pageToken")
                    if not page_token:
                        break  # No more pages
                elif offset_param:
                    # Offset-based: check total count
                    response_data = data.get('response', data)
                    total = (
                        response_data.get('count')
                        or response_data.get('total')
                        or response_data.get('totalCount')
                        or response_data.get('resultsCount')
                    )
                    if total and len(all_stores) >= int(total):
                        break
                    # Get limit value (handle string/int conversion)
                    limit_val = 50
                    if limit_param:
                        limit_val = int(url_params.get(limit_param, 50))
                    if len(new_stores) < limit_val:
                        break  # Last page
                    offset += limit_val
                else:
                    # Number-based: check for has_more, next, or total
                    if "has_more" in data and not data["has_more"]:
                        break
                    if "next" in data and not data["next"]:
                        break
                    total = data.get("total") or data.get("count")
                    if total and len(all_stores) >= total:
                        break
            
            page += 1
            time.sleep(0.3)
            
        except Exception as e:
            log_debug(f"Pagination error on page {page}: {e}", "WARN")
            break
    
    return all_stores


def universal_scrape(
    url: str,
    output_file: str = "output/stores.csv",
    region: str = "world",
    force_type: Optional[str] = None,
    validate_output: bool = True,
    brand_config: Optional[Dict] = None,
    compare_techniques: bool = False,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """
    Universal scraper - auto-detects and handles everything
    
    Args:
        url: Store locator URL/endpoint
        output_file: Output CSV file
        region: Region to scrape if expansion needed
        force_type: Force specific type (viewport, country, pagination, single)
        validate_output: Validate output CSV
        dry_run: If True, skip geocoding, keep rows without coordinates, and skip CSV validation
    
    Returns:
        Dict with results
    """
    if dry_run:
        validate_output = False

    results = {
        "success": False,
        "url": url,
        "detected_type": None,
        "is_region_specific": False,
        "expansion_used": False,
        "stores_found": 0,
        "stores_normalized": 0,
        "output_file": output_file,
        "technique_metrics": None,  # Populated when compare_techniques=True
        "dry_run": dry_run,
    }
    
    print("=" * 80)
    print("🌍 UNIVERSAL STORE SCRAPER")
    print("=" * 80)
    print()
    log_debug(f"Starting scraper | URL: {url[:100]}", "INFO")
    log_debug(f"Region: {region} | Force type: {force_type or 'auto-detect'}", "INFO")
    
    # Step 1: Fetch sample and detect
    print("🔍 Analyzing endpoint...")
    log_debug("PHASE 1: Endpoint Analysis", "INFO")
    
    # Apply per-brand custom headers for initial fetch (from brand_config)
    initial_headers = _get_custom_headers(brand_config)

    # Brands using post_per_country don't accept GET — skip the GET sample probe
    skip_sample_fetch = bool(brand_config and brand_config.get("post_per_country"))

    if skip_sample_fetch:
        log_debug("Skipping GET sample fetch (post_per_country brand)", "DEBUG")
        sample_data = {}
    else:
        try:
            log_debug("Fetching sample data for detection...", "DEBUG")
            sample_data = fetch_data(url, headers=initial_headers)
            log_debug(f"Sample data retrieved successfully", "SUCCESS")
        except Exception as e:
            log_debug(f"Failed to fetch sample data: {e}", "ERROR")
            print(f"❌ Failed to fetch: {e}")
            return results
    
    # Detect locator type
    log_debug("Running locator type detection...", "DEBUG")
    locator_analysis = detect_locator_type(url, sample_data)
    if not force_type:
        detected_type = locator_analysis["detected_type"]
        is_region_specific = locator_analysis["is_region_specific"]
        log_debug(f"Detected type: {detected_type} | Region-specific: {is_region_specific}", "DEBUG")
    else:
        detected_type = force_type
        is_region_specific = force_type in ["viewport", "country_filter", "radius_search"]
        locator_analysis["detected_type"] = detected_type
        locator_analysis["is_region_specific"] = is_region_specific
        log_debug(f"Forced type: {detected_type} | Region-specific: {is_region_specific}", "DEBUG")
    
    results["detected_type"] = detected_type
    results["is_region_specific"] = is_region_specific
    
    print(f"   Type: {detected_type}")
    print(f"   Region-specific: {is_region_specific}")
    
    # Detect field mapping (use brand config if provided, otherwise auto-detect)
    log_debug("Running field mapping detection...", "DEBUG")
    
    if brand_config and brand_config.get("field_mapping"):
        # Use field mapping from brand config
        field_mapping = brand_config.get("field_mapping", {})
        log_debug(f"Using field mapping from brand config: {len(field_mapping)} fields", "DEBUG")
        print(f"   Field mapping: From brand config ({len(field_mapping)} fields)")
    else:
        # Auto-detect field mapping
        pattern = detect_data_pattern(url, sample_data)
        field_mapping = pattern.get("field_mapping", {})
        
        # Handle HTML pages where pattern detection may not work
        is_html_page = isinstance(sample_data, str) and not isinstance(sample_data, (list, dict))
        if is_html_page and not field_mapping:
            log_debug("HTML page detected - pattern detection skipped (will use HTML extraction)", "DEBUG")
            print(f"   Field mapping: HTML/JavaScript extraction (auto-detected)")
        else:
            confidence = pattern.get('mapping_score', {}).get('confidence', 'unknown')
            log_debug(f"Field mapping confidence: {confidence}", "DEBUG")
            log_debug(f"Mapped fields: {len(field_mapping)} | Fields: {list(field_mapping.keys())[:5]}...", "DEBUG")
            print(f"   Field mapping: {confidence.upper()} confidence")
    print()
    
    # Step 2: Scrape with appropriate strategy
    print("📡 Scraping...")
    log_debug("PHASE 2: Data Collection", "INFO")
    scrape_start = time.time()
    
    # Check URL params for radius-based detection (used in multiple branches)
    url_params = locator_analysis["url_params"]
    has_radius = (
        "r" in url_params
        or "radius" in url_params
        or "distance" in url_params
        or "max_distance" in url_params
        or "maxdistance" in url_params
    )
    has_center = "q" in url_params or "lat" in url_params or "latitude" in url_params
    has_radius_cfg = bool(
        brand_config
        and brand_config.get("radius_expansion_radius") is not None
        and str(brand_config.get("radius_expansion_radius", "")).strip() != ""
    )
    has_custom_radius_centers = bool(
        brand_config
        and isinstance(brand_config.get("radius_expansion_centers"), list)
        and len(brand_config["radius_expansion_centers"]) > 0
    )
    force_radius_multi = bool(brand_config and brand_config.get("force_radius_multi_point"))

    try:
        _api_cc = (
            brand_config.get("stores_by_api_countries")
            if brand_config
            else None
        )
        _api_cc_ok = (
            isinstance(_api_cc, dict)
            and str(_api_cc.get("countries_url", "")).strip()
            and "{country_id}" in str(_api_cc.get("stores_url_template", ""))
        )
        _pag_urls = (
            brand_config.get("pagination_fetch_urls")
            if brand_config
            else None
        )
        if brand_config and brand_config.get("post_per_country"):
            # POST-per-country expansion (e.g. Zenith storeLocator) — checked first
            # because the GET-based detector cannot probe a POST-only endpoint.
            log_debug("Strategy: POST per country", "INFO")
            stores = scrape_post_per_country(url, brand_config=brand_config)
            results["expansion_used"] = True
            results["detected_type"] = "post_per_country"
        elif brand_config and _api_cc_ok:
            log_debug(
                "Strategy: stores_by_api_countries (catalog + per-country store URLs)",
                "INFO",
            )
            print("🌐 Brand config: country catalog → per-country store endpoints")
            stores = scrape_stores_by_api_country_catalog(brand_config)
            results["expansion_used"] = True
            results["detected_type"] = "stores_by_api_countries"
        elif (
            brand_config
            and isinstance(_pag_urls, list)
            and len(_pag_urls) > 0
        ):
            log_debug(
                "Strategy: pagination_fetch_urls (explicit paginated endpoints)",
                "INFO",
            )
            print("📄 Pagination via brand config: multiple fetch URLs")
            stores = scrape_pagination_fetch_urls(_pag_urls, brand_config=brand_config)
            results["expansion_used"] = True
            results["detected_type"] = "pagination_fetch_urls"
        elif force_radius_multi and (has_radius or has_radius_cfg) and (
            has_center or has_custom_radius_centers
        ):
            log_debug(
                "Brand config: force_radius_multi_point — multi-center radius expansion",
                "INFO",
            )
            stores = scrape_radius_expansion(
                url, url_params, region, brand_config=brand_config
            )
            results["expansion_used"] = True
        elif detected_type == "paginated":
            # Pagination (check this first before single_call)
            log_debug("Strategy: Paginated scraping", "INFO")
            
            # Check if this is actually a radius-based API that needs multi-point expansion
            # Some APIs use pagination but need multiple center points for worldwide coverage
            # Support both q=... and lat/long=... center point formats
            # If paginated endpoint has radius and center params, treat it as radius-based
            is_radius_based = has_radius and has_center
            
            if is_radius_based:
                # Use radius expansion instead of simple pagination
                log_debug("Radius-based pagination detected - using multi-point expansion", "INFO")
                stores = scrape_radius_expansion(
                    url, url_params, region, brand_config=brand_config
                )
                results["expansion_used"] = True
            else:
                # Standard pagination
                is_token_based = locator_analysis.get("has_token_pagination", False) or "pageToken" in str(sample_data)
                if is_token_based:
                    log_debug("Token-based pagination detected (using pageToken)", "DEBUG")
                
                custom_headers = _get_custom_headers(brand_config)
                stores = scrape_paginated(url, url_params, is_token_based=is_token_based, custom_headers=custom_headers)
                results["expansion_used"] = True
        
        elif detected_type == "viewport":
            # Viewport expansion
            log_debug(f"Strategy: Viewport expansion (region={region})", "INFO")
            stores = scrape_viewport_expansion(
                url, locator_analysis["url_params"], region, brand_config=brand_config
            )
            results["expansion_used"] = True

        elif detected_type == "country_filter":
            # Country expansion (before geo+radius heuristics — some country APIs also pass map center params)
            log_debug(f"Strategy: Country iteration (region={region})", "INFO")

            # Priority order for country list:
            # 1. Brand config with use_watch_store_countries: true -> use comprehensive list
            # 2. Brand config with custom countries -> use custom list
            # 3. Auto-detect: use comprehensive list by default for country-based endpoints
            countries_dict = None
            use_watch_countries = False

            if brand_config:
                # Check if brand config explicitly wants comprehensive list
                if brand_config.get("use_watch_store_countries", False):
                    use_watch_countries = True
                    log_debug("Using comprehensive watch store countries (from brand config)", "DEBUG")
                # Or if custom countries provided
                elif brand_config.get("countries"):
                    countries_dict = brand_config.get("countries")
                    log_debug(f"Using countries from brand config: {len(countries_dict)} countries", "DEBUG")

            # Auto-apply comprehensive list if no brand config preference and country_filter detected
            if not countries_dict and not use_watch_countries:
                use_watch_countries = True
                log_debug("Auto-applying comprehensive watch store countries (country_filter detected)", "DEBUG")
                print("   💡 Auto-detected country-based endpoint - using comprehensive 88-country list")

            stores = scrape_country_expansion(url, locator_analysis["url_params"], region,
                                             countries_dict=countries_dict, brand_config=brand_config,
                                             use_watch_countries=use_watch_countries)
            results["expansion_used"] = True

        elif (
            (detected_type in ("radius", "radius_search") or (has_radius and has_center))
            and not (brand_config and brand_config.get("force_single_call"))
        ):
            # Radius-based API - use multi-point expansion (world city grid + dedupe).
            # Skipped when brand config sets force_single_call (e.g. StoreRocket APIs where
            # a large radius already returns all stores in one call).
            log_debug("Strategy: Radius-based multi-point expansion", "INFO")
            stores = scrape_radius_expansion(
                url, url_params, region, brand_config=brand_config
            )
            results["expansion_used"] = True

        elif brand_config and brand_config.get("geohash_prefix_expansion"):
            # Geohash prefix expansion (e.g. Casio /api/points/{prefix})
            log_debug("Strategy: Geohash prefix expansion", "INFO")
            stores = scrape_geohash_prefix_expansion(url, brand_config=brand_config)
            results["expansion_used"] = True

        elif not is_region_specific or detected_type == "single_call":
            # Single call
            log_debug("Strategy: Single API call", "INFO")
            custom_headers = _get_custom_headers(brand_config)
            stores, tech_metrics = scrape_single_call(
                url,
                custom_headers=custom_headers,
                compare_techniques=compare_techniques,
                brand_config=brand_config,
            )
            results["technique_metrics"] = tech_metrics
            results["expansion_used"] = False

        else:
            # Default to single call
            log_debug("Strategy: Default single call", "INFO")
            custom_headers = _get_custom_headers(brand_config)
            stores, tech_metrics = scrape_single_call(
                url,
                custom_headers=custom_headers,
                compare_techniques=compare_techniques,
                brand_config=brand_config,
            )
            results["technique_metrics"] = tech_metrics
            results["expansion_used"] = False
        
        scrape_time = time.time() - scrape_start
        results["stores_found"] = len(stores)
        log_debug(f"Data collection complete | {len(stores)} stores found | Time: {scrape_time:.2f}s", "SUCCESS")
        print(f"✅ Found {len(stores)} stores")
        print(f"   📊 Raw data collected from endpoint")
        print()
    
    except Exception as e:
        log_debug(f"Scraping failed: {e}", "ERROR")
        print(f"❌ Scraping error: {e}")
        import traceback
        traceback.print_exc()
        return results
    
    if not stores:
        print("❌ No stores found")
        return results

    # Step 2b: Apply row_filters from brand config (before normalization)
    stores = apply_row_filters(stores, brand_config)
    if not stores:
        print("❌ No stores remaining after row_filters")
        return results

    # Step 3: Normalize
    print("🔧 Normalizing data...")
    log_debug("PHASE 3: Data Normalization", "INFO")
    norm_start = time.time()
    print(f"   Processing {len(stores)} raw store records...")
    log_debug(f"Input: {len(stores)} raw records", "DEBUG")
    log_debug(f"Field mapping rules: {len(field_mapping)} fields", "DEBUG")
    
    # Add base URL for resolving partial store URLs (e.g. Bulgari: en-us/storelocator/...)
    parsed = urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}/" if parsed.scheme and parsed.netloc else None
    field_mapping = dict(field_mapping)  # Copy so we don't mutate brand config
    if base_url:
        field_mapping["_base_url"] = base_url
    # Inject brand's url_base for store-detail path reconstruction (e.g. Omega storedetails/<id>)
    if brand_config and brand_config.get("url_base"):
        field_mapping["_url_base"] = brand_config["url_base"]
    
    normalized, excluded_stores = batch_normalize(
        stores,
        field_mapping,
        geocode_missing=not dry_run,
        allow_missing_coordinates=dry_run,
    )
    results["stores_normalized"] = len(normalized)
    results["excluded_stores"] = excluded_stores
    norm_time = time.time() - norm_start
    
    # Calculate how many were filtered out
    filtered_count = len(stores) - len(normalized)
    log_debug(f"Normalization complete | Output: {len(normalized)} records | Filtered: {filtered_count} | Time: {norm_time:.2f}s", "SUCCESS")
    
    print(f"   ✅ {len(normalized)} stores normalized successfully")
    if filtered_count > 0:
        print(f"   ⚠️  {filtered_count} records filtered out (missing required fields)")
        log_debug(f"Filter reason: Missing required fields (name, address, coordinates)", "DEBUG")
    print()
    
    # Step 4: Write CSV
    print(f"💾 Writing to {output_file}...")
    log_debug("PHASE 4: CSV Export", "INFO")
    print(f"   Creating CSV file with {len(normalized)} records...")
    log_debug(f"Output file: {output_file}", "DEBUG")
    
    os.makedirs(os.path.dirname(output_file) if os.path.dirname(output_file) else ".", exist_ok=True)
    write_start = time.time()
    write_normalized_csv(normalized, output_file)
    write_time = time.time() - write_start

    # Write dropped records to companion JSON file (for admin UI)
    dropped_file = output_file.rsplit(".csv", 1)[0] + "_dropped.json"
    if excluded_stores:
        with open(dropped_file, "w", encoding="utf-8") as f:
            json.dump({"excluded_stores": excluded_stores, "count": len(excluded_stores)}, f, indent=2)
    elif os.path.exists(dropped_file):
        os.remove(dropped_file)  # Remove stale dropped file from previous run
    
    file_size = os.path.getsize(output_file) / 1024  # KB
    log_debug(f"CSV export complete | Size: {file_size:.1f} KB | Time: {write_time:.2f}s", "SUCCESS")
    print(f"   ✅ Saved {len(normalized)} records ({file_size:.1f} KB)")
    print()
    
    # Step 5: Validate and Auto-Fix Data Quality Issues
    if validate_output:
        print("📋 Validating and fixing data quality issues...")
        try:
            # Use CSVValidator with auto-fix enabled to clean up common issues
            validator = CSVValidator(
                required_headers=DEFAULT_REQUIRED,
                warn_duplicates=True,
                fail_duplicates=False,
                show_bad=False
            )
            
            # Auto-fix data quality issues (backslashes, control characters, etc.)
            exit_code = validator.validate_file(output_file, auto_fix=True)
            
            # Remove duplicates if any were found
            duplicates_removed = validator.remove_duplicates_from_file(output_file)
            if duplicates_removed > 0:
                print(f"   🔧 Removed {duplicates_removed} duplicate row(s)")
            
            # Re-validate after fixes
            validator = CSVValidator(
                required_headers=DEFAULT_REQUIRED,
                warn_duplicates=True,
                fail_duplicates=False,
                show_bad=False
            )
            exit_code = validator.validate_file(output_file, auto_fix=False)
            
            results["validation_performed"] = True
            results["validation_passed"] = len(validator.errors) == 0
            results["validation_warnings"] = len(validator.warnings)
            results["duplicates_removed"] = duplicates_removed
            results["validation_errors"] = len(validator.errors)
            
            if len(validator.errors) == 0:
                if len(validator.warnings) > 0:
                    print(f"   ✅ Valid (with {len(validator.warnings)} warning(s))")
                else:
                    print(f"   ✅ Valid")
            else:
                print(f"   ⚠️  Has {len(validator.errors)} error(s), {len(validator.warnings)} warning(s)")
                # Print detailed validation errors so users can see what's wrong
                print(f"\n   📋 Validation Error Details:")
                # Group errors by type for better readability
                error_groups = {}
                for error in validator.errors:
                    error_type = error.issue
                    if error_type not in error_groups:
                        error_groups[error_type] = []
                    error_groups[error_type].append(error)
                
                # Show first 10 errors of each type
                for error_type, errors in error_groups.items():
                    print(f"      • {error_type.upper().replace('_', ' ')}: {len(errors)} occurrence(s)")
                    for error in errors[:10]:
                        value_preview = f" (value: {error.value})" if error.value else ""
                        print(f"        - Row {error.row}: {error.field}{value_preview}")
                    if len(errors) > 10:
                        print(f"        ... and {len(errors) - 10} more")
                
                if len(validator.warnings) > 0:
                    print(f"\n   ⚠️  Warnings: {len(validator.warnings)} warning(s)")
                    # Show first 5 warnings
                    for warning in validator.warnings[:5]:
                        print(f"      - {warning}")
                    if len(validator.warnings) > 5:
                        print(f"      ... and {len(validator.warnings) - 5} more")
        except Exception as e:
            results["validation_performed"] = True
            results["validation_passed"] = False
            results["validation_error"] = str(e)
            print(f"   ⚠️  Validation error: {e}")
        print()
    else:
        results["validation_performed"] = False
    
    results["success"] = True
    
    # Collect data-quality warnings from normalized output
    warnings_summary = _collect_data_quality_warnings(normalized)
    results["warnings"] = warnings_summary
    
    # Final summary with performance metrics
    total_time = time.time() - scrape_start
    log_debug("=" * 60, "INFO")
    log_debug("SCRAPING SUMMARY", "INFO")
    log_debug("=" * 60, "INFO")
    log_debug(f"Status: SUCCESS", "SUCCESS")
    log_debug(f"Total Time: {total_time:.2f}s", "INFO")
    log_debug(
        f"Strategy: {results.get('detected_type', detected_type)} "
        f"(expansion={results['expansion_used']})",
        "INFO",
    )
    log_debug(f"Records: {results['stores_found']} found → {results['stores_normalized']} normalized", "INFO")
    log_debug(f"Output: {output_file} ({file_size:.1f} KB)", "INFO")
    if warnings_summary:
        log_debug("", "INFO")
        log_debug("WARNINGS (data quality):", "INFO")
        for msg in warnings_summary:
            log_debug(f"  ⚠️  {msg}", "INFO")
    log_debug("=" * 60, "INFO")
    
    return results


def main():
    parser = argparse.ArgumentParser(
        description='Universal store scraper - auto-detects everything',
        epilog="""
Examples:
  # Auto-detect and scrape (simplest)
  python3 universal_scraper.py --url "https://api.example.com/stores"
  
  # Specify output
  python3 universal_scraper.py --url "..." -o output/my_stores.csv
  
  # Force specific type
  python3 universal_scraper.py --url "..." --type viewport
  
  # Different region (if expansion needed)
  python3 universal_scraper.py --url "..." --region north_america

This ONE script handles:
  ✅ Single endpoints (returns all stores)
  ✅ Viewport APIs (Rolex-style)
  ✅ Country filters (Cartier-style)  
  ✅ HTML + JavaScript (Omega-style)
  ✅ Pagination
  
Auto-detects everything and uses the right strategy!
        """
    )
    
    parser.add_argument('--url', required=True, help='Store locator URL/endpoint')
    parser.add_argument('-o', '--output', default='output/stores.csv', help='Output CSV file')
    parser.add_argument('--region', default='world', help='Region to scrape (world, north_america, europe, etc.)')
    parser.add_argument('--type', choices=['viewport', 'country_filter', 'paginated', 'single_call'], 
                       help='Force specific scraper type (auto-detects if not specified)')
    parser.add_argument('--no-validate', action='store_true', help='Skip validation')
    parser.add_argument('--json-output', help='Also save results as JSON')
    parser.add_argument('--brand-config', help='Brand configuration JSON string (for field mapping)')
    parser.add_argument('--compare-techniques', action='store_true',
                        help='Run multiple extraction techniques and compare data quality (HTML pages only)')
    parser.add_argument('--dry-run', action='store_true',
                        help='No geocoding; keep rows without lat/lon; skip validation (address/text QA)')
    args = parser.parse_args()
    
    # Parse brand config if provided
    brand_config = None
    if args.brand_config:
        try:
            brand_config = json.loads(args.brand_config)
        except json.JSONDecodeError:
            print(f"⚠️  Warning: Invalid brand-config JSON, ignoring")
            brand_config = None

    # Resolve force_type: CLI --type wins, then brand config "type", then auto-detect
    # Normalize "json" (brand config shorthand) to the scraper's "single_call" token
    _TYPE_NORMALISE = {"json": "single_call", "html": "single_call"}
    force_type = args.type
    if not force_type and brand_config:
        cfg_type = brand_config.get("type", "")
        if cfg_type:
            if cfg_type == "json" and brand_config.get("worldwide_country_pagination"):
                # Opt-in: same URL as SPA; iterate countries + offset pages (see scrape_country_expansion)
                force_type = "country_filter"
            elif cfg_type == "json" and brand_config.get("geohash_prefix_expansion"):
                # Geohash prefix expansion: keep force_type as None so universal_scrape
                # can branch on the geohash flag rather than falling into single_call
                pass
            elif cfg_type == "json" and brand_config.get("post_per_country"):
                # POST-per-country: keep force_type as None so universal_scrape
                # can branch on the post_per_country flag
                pass
            else:
                force_type = _TYPE_NORMALISE.get(cfg_type, cfg_type)
            log_debug(f"Using force_type from brand config: {force_type}", "INFO")

    # Run universal scraper
    results = universal_scrape(
        url=args.url,
        output_file=args.output,
        region=args.region,
        force_type=force_type,
        validate_output=not args.no_validate,
        brand_config=brand_config,
        compare_techniques=args.compare_techniques,
        dry_run=args.dry_run,
    )
    
    # Summary
    print("=" * 80)
    if results["success"]:
        print("✅ SUCCESS")
        print(f"   Type: {results['detected_type']}")
        print(f"   Expansion: {'Yes' if results['expansion_used'] else 'No'}")
        print(f"   Stores: {results['stores_found']} found, {results['stores_normalized']} normalized")
        print(f"   Output: {results['output_file']}")
        warnings = results.get("warnings", [])
        if warnings:
            print()
            print("⚠️  WARNINGS (data quality):")
            for msg in warnings:
                print(f"   • {msg}")
    else:
        print("❌ FAILED")
    print("=" * 80)
    
    # Optional JSON output
    if args.json_output:
        with open(args.json_output, 'w') as f:
            json.dump(results, f, indent=2)
        print(f"\n📊 Results saved to: {args.json_output}")
    
    return 0 if results["success"] else 1


if __name__ == "__main__":
    sys.exit(main())

