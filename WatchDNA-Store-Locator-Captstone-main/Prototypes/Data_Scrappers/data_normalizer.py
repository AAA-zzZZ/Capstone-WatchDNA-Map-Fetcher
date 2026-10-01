#!/usr/bin/env python3
"""Transforms scraped data into canonical locations.csv format. Handles field mapping, validation, normalization."""

import re
import csv
import html
import os
import json
import time
from typing import Dict, List, Any, Optional, Tuple, Set
from urllib.parse import urlparse, urljoin

from scraper_utils import resolve_partial_url, dict_get_ci
from country_normalize import normalize_country

CANONICAL_SCHEMA = [
    "Handle", "Name", "Status", "Address Line 1", "Address Line 2", "Postal/ZIP Code",
    "City", "State/Province/Region", "Country", "Phone", "Email", "Website", "Image URL",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Page Title",
    "Page Description", "Meta Title", "Meta Description", "Latitude", "Longitude", "Priority",
    "Name - FR", "Page Title - FR", "Page Description - FR", "Name - ZH-CN", "Page Title - ZH-CN",
    "Page Description - ZH-CN", "Name - ES", "Page Title - ES", "Page Description - ES", " Tags",
    "Custom Brands", "Custom Brands - FR", "Custom Brands - ZH-CN", "Custom Brands - ES",
    "Custom Button title 1", "Custom Button title 1 - FR", "Custom Button title 1 - ZH-CN",
    "Custom Button title 1 - ES", "Custom Button URL 1", "Custom Button URL 1 - FR",
    "Custom Button URL 1 - ZH-CN", "Custom Button URL 1 - ES", "Custom Button title 2",
    "Custom Button title 2 - FR", "Custom Button title 2 - ZH-CN", "Custom Button title 2 - ES",
    "Custom Button URL 2", "Custom Button URL 2 - FR", "Custom Button URL 2 - ZH-CN",
    "Custom Button URL 2 - ES"
]

def load_canonical_schema():
    csv_path2 = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "locations2.csv"))
    if os.path.exists(csv_path2):
        try:
            with open(csv_path2, newline='', encoding='utf-8') as f:
                header_line = f.readline().strip()
                if header_line:
                    # Don't strip individual headers - preserve spaces like " Tags"
                    return [h for h in header_line.split(',')]
        except Exception as e:
            print(f"⚠️  Could not load schema from locations2.csv: {e}")
    csv_path = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "..", "locations.csv"))
    if os.path.exists(csv_path):
        try:
            with open(csv_path, newline='', encoding='utf-8') as f:
                header_line = f.readline().strip()
                if header_line:
                    return [h for h in header_line.split(',')]
        except Exception as e:
            print(f"⚠️  Could not load schema from locations.csv: {e}")
    
    return CANONICAL_SCHEMA

SCHEMA = load_canonical_schema()

# ISO alpha-2 -> English name from watch_store_countries.json (lazy, for combined-address parsing)
_ALPHA2_COUNTRY_NAMES: Optional[Dict[str, str]] = None


def _alpha2_country_name(code: str) -> Optional[str]:
    """Resolve a 2-letter country code to the canonical English name, or None."""
    global _ALPHA2_COUNTRY_NAMES
    if not code or len(code) != 2:
        return None
    c = code.strip().upper()
    if _ALPHA2_COUNTRY_NAMES is None:
        _ALPHA2_COUNTRY_NAMES = {}
        countries_file = os.path.join(os.path.dirname(__file__), "watch_store_countries.json")
        try:
            if os.path.exists(countries_file):
                with open(countries_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                raw = data.get("countries") or {}
                if isinstance(raw, dict):
                    for k, v in raw.items():
                        if isinstance(k, str) and isinstance(v, str) and len(k) == 2:
                            _ALPHA2_COUNTRY_NAMES[k.upper()] = v.strip()
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    name = _ALPHA2_COUNTRY_NAMES.get(c) if _ALPHA2_COUNTRY_NAMES else None
    return name or None


def _decode_unicode_escapes(text: str) -> str:
    """
    Decode literal Unicode escape sequences (e.g. \\u00e3 or /u00e3) to actual characters.
    Handles both proper (\\uXXXX) and malformed (/uXXXX) sequences that can appear when
    JSON/API data is mis-encoded or the backslash is corrupted to forward slash.
    """
    def replace_escape(match: re.Match) -> str:
        try:
            return chr(int(match.group(1), 16))
        except (ValueError, OverflowError):
            return match.group(0)

    # Match \uXXXX or /uXXXX (4 hex digits)
    return re.sub(r'[\\/]u([0-9a-fA-F]{4})', replace_escape, text)


def clean_html_tags(text: Any) -> str:
    """
    Plain-text cleanup for any scraped string: Unicode escapes, HTML entities (&#038; &amp; etc.),
    and tags → spaces, then collapsed whitespace. Used from normalize_field_value and normalize_location.
    """
    if not text:
        return ""

    text_str = str(text).strip()

    # Decode literal Unicode escapes (e.g. /u00e3 -> ã) that may appear in scraped data
    text_str = _decode_unicode_escapes(text_str)
    text_str = html.unescape(text_str)

    # Block/line breaks → space before stripping remaining tags (readable addresses)
    text_str = re.sub(r"(?i)<\s*br\s*/?\s*>", " ", text_str)
    text_str = re.sub(r"(?i)</\s*p\s*>", " ", text_str)
    text_str = re.sub(r"<[^>]+>", " ", text_str)

    text_str = re.sub(r"[\u200E\u200F\u202A-\u202E\u2066-\u2069]", "", text_str)
    text_str = re.sub(r"\s+", " ", text_str)

    return text_str.strip()


def clean_address(address: Any) -> str:
    """
    Clean and normalize address strings by fixing common backslash issues
    
    Fixes:
    - Literal Unicode escapes (\\u00e3, /u00e3 -> ã) that were not properly decoded
    - Backslash before forward slash (\\/ -> /)
    - Double backslashes (\\\\ -> , ) for address separators
    - Spanish Calle abbreviation (C\\/ -> C/)
    
    Args:
        address: Address string that may contain backslash issues
    
    Returns:
        Cleaned address string
    """
    if not address:
        return ""
    
    address_str = str(address).strip()
    
    # Decode literal Unicode escapes first (e.g. Magalh/u00e3es -> Magalhães)
    address_str = _decode_unicode_escapes(address_str)
    
    # Fix backslash before forward slash (\/ -> /)
    # This is the most common issue: 1\/F -> 1/F, C\/ -> C/, MA-66\/103 -> MA-66/103, etc.
    address_str = address_str.replace('\\/', '/')
    
    # Fix Spanish Calle abbreviation (C\/ -> C/)
    # This handles cases where C\/ wasn't caught by the above (shouldn't happen, but safe)
    address_str = re.sub(r'\bC\\/', 'C/', address_str)
    
    # Fix double backslashes (\\ -> , ) for address separators
    # Common pattern: "Mall \\ Location" should be "Mall, Location"
    # Replace \\ with comma and space, but preserve single \ that might be part of Unicode escapes
    # We'll do a simple replacement: \\ -> , 
    # Note: In the CSV string, \\ represents a literal backslash, so we need to match literal \\
    address_str = re.sub(r'\\\\+', ', ', address_str)
    
    # Fix missing space between word and number (e.g. "Junction500" -> "Junction 500", "500Oxford" -> "500 Oxford")
    # Common when source JSON/HTML concatenates address parts without separators.
    # Conservative: only fix word+digits (2+ letters) and digits+word (3+ letters, excluding ordinals st/nd/rd/th)
    address_str = re.sub(r'([a-zA-Z]{2,})(\d+)', r'\1 \2', address_str)  # Junction500 -> Junction 500
    address_str = re.sub(
        r'(\d+)(?!(?:st|nd|rd|th)\b)([a-zA-Z]{3,})',
        r'\1 \2',
        address_str,
        flags=re.IGNORECASE,
    )  # 500Oxford -> 500 Oxford; preserves 41st, 5th, 115A

    # Clean up any double spaces or spaces before commas that might have been created
    address_str = re.sub(r'\s+', ' ', address_str)
    address_str = re.sub(r'\s*,', ',', address_str)  # Remove space before comma
    address_str = re.sub(r',\s*,', ',', address_str)  # Remove double commas

    return address_str.strip()


def parse_combined_address(address_str: str) -> Dict[str, str]:
    """
    Parse a combined address string in 'Street, City[, Postal][, COUNTRY]' format
    into its component parts.

    Designed for sources (e.g. StoreMapper) that return the full address as a
    single comma-delimited string.  Returns a dict with zero or more of:
        street, city, postal, country
    """
    parts = [p.strip() for p in address_str.split(',') if p.strip()]
    if len(parts) < 2:
        return {"street": address_str.strip()}

    result: Dict[str, str] = {}

    # Last part: treat as country if it looks like one (all uppercase word(s) ≥ 3 chars)
    last = parts[-1].strip()
    if re.match(r'^[A-Z][A-Z\s\-]{2,}$', last):
        result["country"] = last.title()
        parts = parts[:-1]
        if not parts:
            return result
        last = parts[-1].strip()

    # Trailing ISO alpha-2 (Storepoint, etc.): "..., City 12345, DE" — only when the
    # segment before the code looks like it includes postal/city digits (avoids most
    # US "City, ST" false positives where ST is a state abbreviation).
    if len(parts) >= 3:
        tail = parts[-1].strip()
        penultimate = parts[-2].strip()
        if re.match(r"^[A-Z]{2}$", tail) and any(ch.isdigit() for ch in penultimate):
            cname = _alpha2_country_name(tail)
            if cname:
                result["country"] = cname
                parts = parts[:-1]
                if not parts:
                    return result
                last = parts[-1].strip()

    # New last part: treat as postal code if it's short and contains a digit
    if re.match(r'^[\w\s\-]{2,10}$', last) and any(c.isdigit() for c in last) and len(last) <= 10:
        result["postal"] = last
        parts = parts[:-1]
        if not parts:
            return result

    # Remaining: last part is city, everything before is the street
    if len(parts) >= 2:
        result["city"] = parts[-1].strip()
        result["street"] = ", ".join(parts[:-1])
    else:
        result["street"] = parts[0].strip()

    return result


def strip_redundant_address_parts(
    addr1: str, city: str, state: str, country: str, postal: str = ""
) -> str:
    """
    Remove trailing city, state, country (and optionally state+postal) from Address Line 1
    when they exist in separate fields. Prevents display duplication when full_address or
    combined address is used for Address Line 1.

    Args:
        addr1: Address Line 1 (may contain full address with city/state/country)
        city: City from separate field
        state: State/Province/Region from separate field
        country: Country from separate field
        postal: Postal/ZIP Code from separate field (optional, used to strip ", state postal")

    Returns:
        Address Line 1 with redundant trailing parts stripped
    """
    if not addr1 or not addr1.strip():
        return addr1
    result = addr1.strip()
    # Strip from right: country, state+postal (or state), city (reverse order)
    # 1. Country
    if country and country.strip():
        part_clean = country.strip()
        for suffix in [f", {part_clean}", f",{part_clean}"]:
            if result.lower().endswith(suffix.lower()) and len(result) > len(suffix):
                result = result[:-len(suffix)].rstrip().rstrip(',').strip()
                break
    # 2. State (possibly followed by postal, e.g. ", NH 1071 AZ")
    if state and state.strip():
        part_clean = state.strip()
        stripped = False
        if postal and postal.strip():
            postal_clean = postal.strip()
            for suffix in [
                f", {part_clean} {postal_clean}",
                f",{part_clean} {postal_clean}",
            ]:
                if result.lower().endswith(suffix.lower()) and len(result) > len(suffix):
                    result = result[:-len(suffix)].rstrip().rstrip(',').strip()
                    stripped = True
                    break
        if not stripped:
            for suffix in [f", {part_clean}", f",{part_clean}"]:
                if result.lower().endswith(suffix.lower()) and len(result) > len(suffix):
                    result = result[:-len(suffix)].rstrip().rstrip(',').strip()
                    break
    # 3. City
    if city and city.strip():
        part_clean = city.strip()
        for suffix in [f", {part_clean}", f",{part_clean}"]:
            if result.lower().endswith(suffix.lower()) and len(result) > len(suffix):
                result = result[:-len(suffix)].rstrip().rstrip(',').strip()
                break

    # 4. Comma-separated tails: drop trailing "City" or "City Province/Governorate/…" when the same
    # city is already in its own field but API left admin area only in line1 (e.g. FC / Google route).
    result = _dedupe_trailing_address_segments(result, city)
    return result


def _dedupe_trailing_address_segments(addr1: str, city: str) -> str:
    """
    Remove rightmost comma segments that only repeat the City field or spell "{City} Province" etc.
    Avoids "…, Tehran, Tehran Province" when City is already Tehran and State was not populated.
    """
    if not addr1 or not (city or "").strip():
        return addr1
    parts = [p.strip() for p in addr1.split(",") if p.strip()]
    if len(parts) <= 1:
        return addr1
    c_low = city.strip().lower()
    admin_endings = (
        "province",
        "governorate",
        "region",
        "prefecture",
        "municipality",
        "oblast",
        "krai",
        "voivodeship",
        "county",
    )
    while len(parts) >= 2:
        last = parts[-1].strip().lower()
        if last == c_low:
            parts.pop()
            continue
        if last.startswith(c_low + " ") and any(last.endswith(adm) for adm in admin_endings):
            parts.pop()
            continue
        break
    return ", ".join(parts)


def validate_coordinate(value: Any, coord_type: str = "latitude") -> str:
    """
    Validate and normalize a coordinate value.

    Args:
        value: Raw coordinate value (string, float, int, etc.)
        coord_type: "latitude" or "longitude"

    Returns:
        Normalized coordinate string with 7 decimal places, or empty string if invalid
    """
    return normalize_coordinate_string(value, coord_type)


def _normalize_phone_for_parse(phone_str: str) -> str:
    """Preprocess phone string to help phonenumbers parse."""
    s = phone_str.strip()
    # (+8628) 12345678 -> +86 28 12345678 (China style with area in parens)
    s = re.sub(r'\(\+86(\d*)\)\s*', r'+86 \1 ', s)
    # (+1) or (+44) etc -> +1  or +44
    s = re.sub(r'\(\+(\d{1,3})\)\s*', r'+\1 ', s)
    # Remove (0) domestic prefix (e.g. +31 (0)10 -> +31 10)
    s = re.sub(r'\s*\(0\)\s*', ' ', s)
    # Strip domestic leading 0 from area codes: (022) -> 22, (010) -> 10 (China, Europe, etc.)
    s = re.sub(r'\(0(\d+)\)', r'\1', s)
    return s.strip()


def _country_name_to_alpha2(country_name: str) -> Optional[str]:
    """Convert a country display name (e.g. 'South Korea') to ISO alpha-2 ('KR') for phonenumbers."""
    if not country_name:
        return None
    s = country_name.strip()
    if re.match(r'^[A-Za-z]{2}$', s):
        return s.upper()
    try:
        import pycountry
        result = pycountry.countries.get(name=s)
        if result:
            return result.alpha_2
        results = pycountry.countries.search_fuzzy(s)
        if results:
            return results[0].alpha_2
    except Exception:
        pass
    return None


def validate_phone(phone: Any, country: str = "") -> str:
    """
    Normalize phone number format using Google's phonenumbers library.
    Pass country (display name or alpha-2) so local numbers without a + prefix
    can be correctly identified and formatted.
    """
    import phonenumbers
    from phonenumbers import PhoneNumberFormat

    if not phone:
        return ""

    phone_str = str(phone).strip()

    # Preserve extension - extract before parsing (x 123, ext. 123)
    # Note: hyphen-only extensions (-8008) are intentionally excluded because they are
    # indistinguishable from the last segment of a normal phone number (e.g. 031-690-1557).
    ext_match = re.search(r'(?:\s+[xX]\s*\d[\d\s]*|\s+ext\.?\s*\d[\d\s]*)$', phone_str, re.IGNORECASE)
    extension = ext_match.group(0).strip() if ext_match else ""
    if extension:
        phone_str = phone_str[: ext_match.start()].strip()

    # Remove common unwanted chars but preserve valid ones
    phone_str = re.sub(r'[^\d+\-()\s]', '', phone_str)
    phone_str = re.sub(r'\s+', ' ', phone_str).strip()

    if not phone_str:
        return ""

    normalized = _normalize_phone_for_parse(phone_str)
    region = _country_name_to_alpha2(country) if country else None

    # Try with region hint first — essential for local numbers that have no + prefix
    if region:
        try:
            parsed = phonenumbers.parse(normalized, region)
            if phonenumbers.is_valid_number(parsed):
                formatted = phonenumbers.format_number(parsed, PhoneNumberFormat.INTERNATIONAL)
                return (formatted + " " + extension).strip() if extension else formatted
        except Exception:
            pass

    # Fall back to region-free parse for numbers that already carry a country code (+XX...)
    try:
        parsed = phonenumbers.parse(normalized, None)
        if phonenumbers.is_valid_number(parsed) or phonenumbers.is_possible_number(parsed):
            formatted = phonenumbers.format_number(parsed, PhoneNumberFormat.INTERNATIONAL)
            return (formatted + " " + extension).strip() if extension else formatted
    except Exception:
        pass

    return (phone_str + " " + extension).strip() if extension else phone_str


def validate_email(email: Any) -> str:
    """
    Basic email validation
    
    Returns cleaned email or empty string if invalid
    """
    if not email:
        return ""
    
    email_str = str(email).strip().lower()
    
    # Basic email pattern
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    
    if re.match(pattern, email_str):
        return email_str
    
    return ""


def _is_url_partial(url_str: str) -> bool:
    """
    Detect if a URL is partial (path-only or has invalid host like locale code).
    E.g. 'https://en-us/storelocator/...' has host 'en-us' which is a path segment, not a domain.
    """
    parsed = urlparse(url_str)
    if not parsed.scheme:
        return True
    netloc = (parsed.netloc or "").lower()
    if not netloc:
        return True
    # No TLD: real domains have a dot (e.g. www.bulgari.com)
    if "." not in netloc:
        return True
    # Locale-like host (e.g. en-us, fr-fr) - these are path segments, not domains
    if re.match(r"^[a-z]{2}-[a-z]{2}$", netloc):
        return True
    return False


def _is_image_url(url_str: str) -> bool:
    """
    Check if URL points to an image file (not a store page).
    Only returns True when the path's last segment ends with an image extension,
    avoiding false positives like 'store-locator-jpg-guide.html' or paths containing
    'png' or 'jpg' as substrings.
    """
    parsed = urlparse(url_str)
    path = (parsed.path or "").strip()
    if not path:
        return False
    last_segment = path.rstrip("/").split("/")[-1].lower()
    image_extensions = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg")
    return any(last_segment.endswith(ext) for ext in image_extensions)


def validate_url(url: Any, validate_http: bool = False, base_url: Optional[str] = None,
                 field_context: Optional[str] = None, url_base: Optional[str] = None, **kwargs) -> str:
    """
    Validate and normalize URL.

    Resolves relative store-detail paths using url_base when provided (brand config key).
    Resolves other partial URLs against base_url when provided.
    Rejects image URLs when field_context is "Website".
    Optionally validates URLs via HTTP request.

    Args:
        url: URL string to validate
        validate_http: If True, make HTTP request to verify URL is accessible
        base_url: Optional base URL for resolving locale-prefixed partial URLs
        field_context: Optional field name - when "Website", image URLs are rejected
        url_base: Brand's base URL for reconstructing relative store-detail paths (from brand_config)

    Returns:
        Validated and normalized URL, or empty string if invalid
    """
    if not url:
        return ""
    
    url_str = str(url).strip()
    
    # Fix escaped slashes (\/ -> /)
    url_str = url_str.replace('\\/', '/').replace('\\', '/')

    # Reconstruct relative store-detail URLs using the brand's url_base (brand_config key)
    url_str = resolve_partial_url(url_str, url_base)

    # If it's a relative URL or missing scheme, add https://
    if url_str and not urlparse(url_str).scheme:
        url_str = f"https://{url_str}"
    
    # Resolve partial URLs (path-only or host that looks like locale/path) against base_url
    if base_url and _is_url_partial(url_str):
        parsed_partial = urlparse(url_str)
        base = base_url.rstrip("/") + "/"
        # If netloc looks like a path segment (e.g. en-us), treat netloc+path as the path
        if parsed_partial.netloc and "." not in parsed_partial.netloc:
            path_part = f"{parsed_partial.netloc}{parsed_partial.path or ''}"
        else:
            path_part = parsed_partial.path or url_str.lstrip("/")
        if parsed_partial.query:
            path_part += "?" + parsed_partial.query
        url_str = urljoin(base, path_part)
    
    # Basic validation - must have scheme and netloc
    parsed = urlparse(url_str)
    if not (parsed.scheme and parsed.netloc):
        return ""

    # Reject image URLs when this is the Website field (store page, not store photo)
    if field_context == "Website" and _is_image_url(url_str):
        return ""

    # Optional HTTP validation
    if validate_http:
        try:
            import requests
            response = requests.head(url_str, timeout=5, allow_redirects=True)
            if response.status_code >= 400:
                # If HEAD fails, try GET
                response = requests.get(url_str, timeout=5, allow_redirects=True, stream=True)
                if response.status_code >= 400:
                    return ""  # URL not accessible
        except Exception:
            # If validation fails (network error, etc.), still return the URL
            # as it might be valid but temporarily unavailable
            pass
    
    return url_str


def validate_boolean(value: Any, default: bool = True) -> str:
    """
    Convert various boolean representations to "TRUE" or "FALSE"
    
    Args:
        value: Any value that might represent a boolean
        default: Default value if conversion fails
    
    Returns:
        "TRUE" or "FALSE"
    """
    if value is None:
        return "TRUE" if default else "FALSE"
    
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    
    str_val = str(value).strip().lower()
    
    # True values
    if str_val in ("1", "true", "yes", "y", "active", "enabled", "on"):
        return "TRUE"
    
    # False values
    if str_val in ("0", "false", "no", "n", "inactive", "disabled", "off"):
        return "FALSE"
    
    return "TRUE" if default else "FALSE"


def generate_handle(name: str, city: str = "", existing_handles: Optional[Set[str]] = None) -> str:
    """
    Generate a URL-friendly handle from name and city
    
    Args:
        name: Store name
        city: Store city (optional, helps with uniqueness)
        existing_handles: Set of handles already in use (for uniqueness)
    
    Returns:
        URL-friendly handle string
    """
    if not name:
        name = "store"
    
    # Combine name and city
    base = f"{name}-{city}" if city else name
    
    # Convert to lowercase and replace spaces/special chars with hyphens
    handle = re.sub(r'[^\w\s-]', '', base.lower())
    handle = re.sub(r'[-\s]+', '-', handle)
    handle = handle.strip('-')
    
    # Ensure uniqueness if existing_handles provided
    if existing_handles is not None:
        if handle in existing_handles:
            counter = 1
            while f"{handle}-{counter}" in existing_handles:
                counter += 1
            handle = f"{handle}-{counter}"
        existing_handles.add(handle)
    
    return handle


# FIELD MAPPING AND EXTRACTION

# Canonical field aliases for fuzzy key matching (when explicit mapping is missing/empty)
FIELD_MAPPING_ALIASES = {
    "Name": [
        "name",
        "Name",
        "title",
        "label",
        "storeName",
        "store_name",
        "displayName",
        "establishment_name",
        "nameTranslated",
        "shortName",
        "properties.name",
        "store.name",
        "pos.name",
    ],
    "Address Line 1": ["address", "address1", "streetAddress", "street_address", "streetaddress", "line1", "adr", "shortAddress", "full_address", "address_line_1"],
    "Address Line 2": ["address2", "address_line_2", "street2", "line2"],
    "City": ["city", "cityName", "city_name", "locality"],
    "State/Province/Region": ["state", "region", "stateName", "regionName", "province", "stateCode", "isoRegionCode"],
    "Country": ["country", "countryName", "country_name", "countryCode"],
    "Postal/ZIP Code": ["zip", "zipcode", "postalCode", "postal_code", "postcode"],
    "Phone": ["phone", "phone1", "phone2", "mainPhone", "telephone", "tel", "mobile", "dealerPhone"],
    "Email": ["email", "emails", "contact_email", "mail"],
    "Website": ["website", "url", "websiteUrl", "permalink", "dealerSiteUrl"],
    "Latitude": ["lat", "latitude", "loc_lat", "y"],
    "Longitude": ["lng", "lon", "longitude", "loc_long", "x"],
    "Handle": ["id", "handle", "store_id", "dealerId", "meta.id"],
}


def normalize_field_value(value: Any) -> str:
    """
    Convert extracted field value to string, handling arrays and objects.
    Used for APIs that return emails as ['x@y.com'] or phone as {display: "..."}.
    All string output runs through clean_html_tags (entities + tags + whitespace).
    """
    if value is None:
        return ""
    if isinstance(value, str):
        return clean_html_tags(value)
    if isinstance(value, list):
        # Take first non-empty element, or join if multiple
        non_empty = [normalize_field_value(v) for v in value if v is not None]
        non_empty = [s for s in non_empty if s]
        if not non_empty:
            return ""
        if len(non_empty) == 1:
            return non_empty[0]
        return ", ".join(non_empty[:3])  # Cap at 3 to avoid huge strings
    if isinstance(value, dict):
        # Try common keys for phone/email objects
        for key in ["display", "value", "number", "raw", "formatted"]:
            if key in value and value[key]:
                return normalize_field_value(value[key])
        # Fallback: first non-empty value
        for v in value.values():
            if v and isinstance(v, str):
                return normalize_field_value(v)
        return ""
    return clean_html_tags(str(value).strip())


def get_nested_value(obj: Dict, path: str) -> Any:
    """
    Extract nested value from dict using dot notation path
    
    Args:
        obj: Dictionary to extract from
        path: Dot-notation path (e.g., "address.city" or "yextDisplayCoordinate.latitude")
    
    Returns:
        Value at path or None if not found
    """
    if not path or not obj:
        return None
    
    keys = path.split('.')
    value = obj
    
    for key in keys:
        if isinstance(value, dict):
            value = dict_get_ci(value, key)
            if value is None:
                return None
        else:
            return None
    
    return value


def _extract_value_by_path(raw_data: Dict, path: str) -> Any:
    """Extract value using dot notation or direct key. Returns raw value (not normalized)."""
    if '.' in path:
        parts = path.split('.')
        value = raw_data
        for part in parts:
            if value is None:
                return None
            if isinstance(value, dict):
                value = dict_get_ci(value, part)
            elif isinstance(value, list):
                try:
                    idx = int(part)
                    if 0 <= idx < len(value):
                        value = value[idx]
                    else:
                        return None
                except ValueError:
                    return None
            else:
                return None
        return value
    return dict_get_ci(raw_data, path)


def _fuzzy_extract(raw_data: Dict, canonical_field: str) -> str:
    """Try to find value using alias keys when explicit mapping returned empty."""
    aliases = FIELD_MAPPING_ALIASES.get(canonical_field, [])
    for alias in aliases:
        value = _extract_value_by_path(raw_data, alias)
        if value is not None and value != "":
            return normalize_field_value(value)
    if isinstance(raw_data, dict):
        for key, val in raw_data.items():
            if val and isinstance(val, (str, int, float)):
                key_lower = key.lower()
                if canonical_field == "Phone" and any(p in key_lower for p in ["phone", "tel"]):
                    return normalize_field_value(val)
                if canonical_field == "Email" and any(p in key_lower for p in ["email", "mail"]):
                    return normalize_field_value(val)
                if canonical_field == "Address Line 1" and any(p in key_lower for p in ["address", "street", "line1"]):
                    return normalize_field_value(val)
            if isinstance(val, dict) and canonical_field in [
                "Phone",
                "Email",
                "Address Line 1",
                "Name",
            ]:
                nested = _fuzzy_extract(val, canonical_field)
                if nested:
                    return nested
    return ""


def extract_field(raw_data: Dict, field_config: Any, canonical_field: str = "", use_fuzzy_fallback: bool = True) -> Any:
    """
    Extract a field value from raw data. Handles arrays/objects via normalize_field_value.
    Optionally uses fuzzy key matching when explicit mapping returns empty.
    
    Returns:
        Extracted value as string (normalized)
    """
    value = None
    if isinstance(field_config, str):
        value = _extract_value_by_path(raw_data, field_config)
    elif isinstance(field_config, list):
        for key in field_config:
            value = get_nested_value(raw_data, key) if key else None
            if value is not None and value != "":
                break
    elif isinstance(field_config, dict):
        join_paths = field_config.get("join")
        if join_paths and isinstance(join_paths, list):
            sep = str(field_config.get("separator", " "))
            skip_tokens = field_config.get("skip_tokens", ["n/a", "na", "-", "—"])
            skip_l = {str(t).strip().lower() for t in skip_tokens if str(t).strip()}
            parts: List[str] = []
            for p in join_paths:
                if not p:
                    continue
                v = _extract_value_by_path(raw_data, str(p))
                if v is None:
                    continue
                s = str(v).strip()
                if not s or s.lower() in skip_l:
                    continue
                sl = s.lower()
                if any(sl in ex.lower() or ex.lower() in sl for ex in parts):
                    continue
                parts.append(s)
            value = sep.join(parts) if parts else None
        else:
            key = field_config.get("key", "")
            default = field_config.get("default", "")
            value = get_nested_value(raw_data, key) if key else None
            if value is None:
                value = default
            transform = field_config.get("transform")
            if transform and callable(transform):
                value = transform(value)
    
    result = normalize_field_value(value) if value is not None else ""
    if not result and use_fuzzy_fallback and canonical_field:
        result = _fuzzy_extract(raw_data, canonical_field)
    return result


def apply_field_mapping(raw_data: Dict, field_mapping: Dict[str, Any]) -> Dict[str, str]:
    """
    Apply field mapping to transform raw data into canonical schema
    
    Args:
        raw_data: Raw scraped data dictionary
        field_mapping: Dictionary mapping canonical field names to source field configs
    
    Returns:
        Dictionary with canonical field names and extracted values
    """
    mapped_data = {}
    for canonical_field, source_config in field_mapping.items():
        # Skip special keys (e.g. _base_url for URL resolution context)
        if canonical_field.startswith("_"):
            continue
        mapped_data[canonical_field] = extract_field(raw_data, source_config, canonical_field=canonical_field)
    return mapped_data


# COUNTRY INFERENCE FUNCTION

def infer_country_from_address(
    address: str,
    city: str = "",
    state: str = "",
    country: str = ""
) -> str:
    """
    Infer country from address fields by matching country names and common patterns.
    
    Args:
        address: Address line 1
        city: City name
        state: State/Province/Region
        country: Existing country (if already set, return it)
    
    Returns:
        Country name if found, empty string otherwise
    """
    # If country is already set, return it
    if country and country.strip():
        return country.strip()
    
    # Load country names from watch_store_countries.json
    countries_file = os.path.join(os.path.dirname(__file__), "watch_store_countries.json")
    country_names = []
    country_codes_to_names = {}
    
    try:
        if os.path.exists(countries_file):
            with open(countries_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if "countries" in data:
                    # Get country code to name mapping
                    country_codes_to_names = data["countries"]
                    # Get all country names (values)
                    country_names = list(country_codes_to_names.values())
                    # Also add common variations
                    country_variations = {
                        "United States": ["USA", "US", "U.S.", "U.S.A.", "United States of America"],
                        "United Kingdom": ["UK", "U.K.", "Great Britain", "Britain", "England", "Scotland", "Wales"],
                        "United Arab Emirates": ["UAE", "U.A.E."],
                        "South Korea": ["Korea", "South Korea", "Republic of Korea"],
                        "Czech Republic": ["Czechia"],
                        "Hong Kong": ["HK"],
                    }
                    for main_name, variations in country_variations.items():
                        if main_name in country_names:
                            country_names.extend(variations)
    except Exception:
        # Fallback to common country names if file not found
        country_names = [
            "United States", "Canada", "Mexico", "United Kingdom", "France", "Germany",
            "Italy", "Spain", "Switzerland", "Japan", "China", "Hong Kong", "Singapore",
            "Australia", "United Arab Emirates", "Saudi Arabia", "Brazil", "Argentina"
        ]
    
    # Combine all address fields into one search string
    search_text = f"{address} {city} {state}".lower()
    
    # Search for country names (longest first to match "United States" before "States")
    # But avoid false matches like "Wales" in "New South Wales"
    country_names_sorted = sorted(country_names, key=len, reverse=True)
    
    # Exclude "Wales" from matching (to avoid matching "New South Wales")
    excluded_matches = {"wales"}  # Can add more if needed
    
    for country_name in country_names_sorted:
        country_lower = country_name.lower()
        if country_lower in excluded_matches:
            continue  # Skip excluded matches
        if country_lower in search_text:
            # Additional check: if matching "Wales", make sure it's not part of "New South Wales" or similar
            if country_lower == "wales":
                if "new south wales" in search_text or "south wales" in search_text:
                    continue
            return country_name
    
    # Try to infer from Australian states first (to avoid WA conflict)
    australian_states_abbrev = {"NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"}
    if state and state.strip().upper() in australian_states_abbrev:
        return "Australia"
    
    # Try to infer from US state abbreviations (common pattern)
    # Note: WA is excluded here as it could be Western Australia
    us_states = {
        "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
        "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
        "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
        "VA", "WV", "WI", "WY"
    }
    if state and state.strip().upper() in us_states:
        return "United States"
    
    # Handle WA specifically - check city for context
    if state and state.strip().upper() == "WA":
        # If city is known Australian city, it's Australia; otherwise assume US
        australian_cities = {"perth", "fremantle", "bunbury", "geraldton", "kalgoorlie"}
        if city and city.lower().strip() in australian_cities:
            return "Australia"
        else:
            return "United States"  # Default to US (Washington)
    
    # Try to infer from Canadian provinces
    canadian_provinces = {
        "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"
    }
    if state and state.strip().upper() in canadian_provinces:
        return "Canada"
    
    # Try to infer from Australian states/territories (full names)
    australian_states_full = {
        "New South Wales", "Victoria", "Queensland", "Western Australia",
        "South Australia", "Tasmania", "Australian Capital Territory", "Northern Territory"
    }
    if state and state.strip() in australian_states_full:
        return "Australia"
    # Also check if state contains Australian state name
    state_lower = state.lower() if state else ""
    if "queensland" in state_lower or "new south wales" in state_lower or "western australia" in state_lower:
        return "Australia"
    
    # Common city-to-country mappings (for well-known cities)
    city_country_map = {
        "london": "United Kingdom",
        "paris": "France",
        "tokyo": "Japan",
        "berlin": "Germany",
        "rome": "Italy",
        "madrid": "Spain",
        "amsterdam": "Netherlands",
        "vienna": "Austria",
        "zurich": "Switzerland",
        "geneva": "Switzerland",
        "milan": "Italy",
        "barcelona": "Spain",
        "munich": "Germany",
        "frankfurt": "Germany",
        "brussels": "Belgium",
        "copenhagen": "Denmark",
        "stockholm": "Sweden",
        "oslo": "Norway",
        "helsinki": "Finland",
        "dublin": "Ireland",
        "lisbon": "Portugal",
        "athens": "Greece",
        "warsaw": "Poland",
        "prague": "Czech Republic",
        "budapest": "Hungary",
        "bucharest": "Romania",
        "sydney": "Australia",
        "melbourne": "Australia",
        "auckland": "New Zealand",
        "singapore": "Singapore",
        "hong kong": "Hong Kong",
        "dubai": "United Arab Emirates",
        "riyadh": "Saudi Arabia",
        "doha": "Qatar",
        "kuwait city": "Kuwait",
        "manama": "Bahrain",
        "muscat": "Oman",
        "tel aviv": "Israel",
        "istanbul": "Turkey",
        "cairo": "Egypt",
        "johannesburg": "South Africa",
        "cape town": "South Africa",
        "sao paulo": "Brazil",
        "rio de janeiro": "Brazil",
        "buenos aires": "Argentina",
        "santiago": "Chile",  # Most common Santiago is in Chile
        "lima": "Peru",
        "bogota": "Colombia",
        "mexico city": "Mexico",
        "moscow": "Russia",
        "beijing": "China",
        "shanghai": "China",
        "seoul": "South Korea",
        "taipei": "Taiwan",
        "bangkok": "Thailand",
        "kuala lumpur": "Malaysia",
        "jakarta": "Indonesia",
        "manila": "Philippines",
        "ho chi minh city": "Vietnam",
        "mumbai": "India",
        "delhi": "India",
        "karachi": "Pakistan",
        "marigot": "France",  # Saint Martin (French territory)
    }
    
    city_lower = city.lower().strip()
    if city_lower in city_country_map:
        return city_country_map[city_lower]
    
    # Check for US territories and special cases
    us_territories = {
        "saipan": "United States",  # Northern Mariana Islands (US territory)
        "guam": "United States",
        "puerto rico": "United States",
        "us virgin islands": "United States",
    }
    
    search_lower = search_text.lower()
    for territory, country in us_territories.items():
        if territory in search_lower:
            return country
    
    return ""


# COORDINATE & GEOCODING (delegate to shared utilities)

from coordinate_utils import normalize_coordinate_string
from geocoding_utils import (
    GEOPY_AVAILABLE as _GEOPY_AVAILABLE,
    get_geocoder,
    geocode_address,
)
GEOPY_AVAILABLE = _GEOPY_AVAILABLE


# MAIN NORMALIZATION FUNCTION

def normalize_location(
    raw_data: Dict[str, Any],
    field_mapping: Optional[Dict[str, Any]] = None,
    existing_handles: Optional[Set[str]] = None
) -> Dict[str, str]:
    """
    The definitive algorithm for normalizing store location data
    
    This function transforms any raw scraped data into the canonical format.
    
    Args:
        raw_data: Raw data dictionary from scraper
        field_mapping: Optional mapping of canonical fields to source fields
                      If None, assumes raw_data already uses canonical field names
        existing_handles: Set of existing handles (for uniqueness)
    
    Returns:
        Normalized dictionary matching the canonical schema
    """
    # Initialize with empty values for all canonical fields
    normalized = {field: "" for field in SCHEMA}
    
    # Apply field mapping if provided (and has actual field rules, not just _base_url etc.)
    data_fields = [k for k in (field_mapping or {}) if not k.startswith("_")]
    if field_mapping and data_fields:
        mapped_data = apply_field_mapping(raw_data, field_mapping)
    else:
        mapped_data = raw_data
    
    # Basic fields (direct copy with cleaning - also clean HTML tags)
    normalized["Name"] = clean_html_tags(mapped_data.get("Name", ""))
    # Address fields need special cleaning for backslash issues
    addr1 = clean_address(clean_html_tags(mapped_data.get("Address Line 1", "")))
    # Universal fallback: when address_line_1/address1 is blank but full_address exists, use it
    if not addr1 and raw_data:
        for key in ["full_address", "address_line_1", "addressLine1", "address1", "address", "streetAddress"]:
            val = raw_data.get(key)
            if val and isinstance(val, str) and val.strip():
                addr1 = clean_address(clean_html_tags(val.strip()))
                if addr1:
                    break
    normalized["Address Line 1"] = addr1
    normalized["Address Line 2"] = clean_address(clean_html_tags(mapped_data.get("Address Line 2", "")))
    normalized["Postal/ZIP Code"] = clean_html_tags(mapped_data.get("Postal/ZIP Code", ""))
    normalized["City"] = clean_html_tags(mapped_data.get("City", ""))
    normalized["State/Province/Region"] = clean_html_tags(mapped_data.get("State/Province/Region", ""))
    country_raw = clean_html_tags(mapped_data.get("Country", ""))

    # If a combined address field is configured, parse it to fill empty components.
    # Activated via "_parse_combined_address": "<source_field>" in the field mapping.
    if field_mapping:
        parse_src = field_mapping.get("_parse_combined_address")
        if parse_src and not normalized["City"]:
            raw_addr = raw_data.get(parse_src, "")
            if raw_addr and isinstance(raw_addr, str):
                parsed = parse_combined_address(raw_addr)
                if parsed.get("street"):
                    normalized["Address Line 1"] = parsed["street"]
                    normalized["Address Line 2"] = ""
                if parsed.get("city"):
                    normalized["City"] = parsed["city"]
                if not normalized["Postal/ZIP Code"] and parsed.get("postal"):
                    normalized["Postal/ZIP Code"] = parsed["postal"]
                if not country_raw and parsed.get("country"):
                    country_raw = parsed["country"]

    # If country is missing, try to infer it from address
    if not country_raw or not country_raw.strip():
        inferred_country = infer_country_from_address(
            normalized["Address Line 1"],
            normalized["City"],
            normalized["State/Province/Region"],
            country_raw
        )
        normalized["Country"] = normalize_country(inferred_country) if inferred_country else ""
    else:
        normalized["Country"] = normalize_country(country_raw)
    
    # Strip redundant city/state/country from Address Line 1 when in separate fields (avoids display duplication)
    normalized["Address Line 1"] = strip_redundant_address_parts(
        normalized["Address Line 1"],
        normalized["City"],
        normalized["State/Province/Region"],
        normalized["Country"],
        normalized.get("Postal/ZIP Code", ""),
    )
    
    normalized["Priority"] = clean_html_tags(mapped_data.get("Priority", ""))
    
    # Base URL for resolving partial store URLs (e.g. Bulgari paths like en-us/storelocator/...)
    base_url = field_mapping.get("_base_url") if field_mapping else None
    # Brand's url_base for reconstructing relative store-detail paths (e.g. Omega's storedetails/<id>)
    url_base = field_mapping.get("_url_base") if field_mapping else None

    # Validated fields
    normalized["Status"] = validate_boolean(mapped_data.get("Status", True), default=True)
    normalized["Phone"] = validate_phone(mapped_data.get("Phone", ""), country=normalized["Country"])
    normalized["Email"] = validate_email(mapped_data.get("Email", ""))
    normalized["Website"] = validate_url(mapped_data.get("Website", ""), base_url=base_url, url_base=url_base, field_context="Website")
    normalized["Image URL"] = validate_url(mapped_data.get("Image URL", ""), base_url=base_url, url_base=url_base)
    
    # Coordinates (critical for mapping)
    normalized["Latitude"] = validate_coordinate(mapped_data.get("Latitude", ""), "latitude")
    normalized["Longitude"] = validate_coordinate(mapped_data.get("Longitude", ""), "longitude")
    
    # Generate handle if missing
    normalized["Handle"] = str(mapped_data.get("Handle", "")).strip()
    if not normalized["Handle"]:
        normalized["Handle"] = generate_handle(
            normalized["Name"],
            normalized["City"],
            existing_handles
        )
    elif existing_handles is not None:
        existing_handles.add(normalized["Handle"])
    
    # Store hours (typically left empty, but include if provided)
    for day in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]:
        normalized[day] = str(mapped_data.get(day, "")).strip()
    
    # Page metadata
    normalized["Page Title"] = str(mapped_data.get("Page Title", "")).strip()
    normalized["Page Description"] = str(mapped_data.get("Page Description", "")).strip()
    normalized["Meta Title"] = str(mapped_data.get("Meta Title", "")).strip()
    normalized["Meta Description"] = str(mapped_data.get("Meta Description", "")).strip()
    
    # Tags and brands (handle lists or comma-separated strings)
    tags = mapped_data.get(" Tags", mapped_data.get("Tags", ""))  # Support both with and without space
    if isinstance(tags, list):
        normalized[" Tags"] = ",".join([str(t).strip() for t in tags if t])
    else:
        normalized[" Tags"] = str(tags).strip()
    
    brands = mapped_data.get("Custom Brands", "")
    if isinstance(brands, list):
        normalized["Custom Brands"] = ",".join([str(b).strip() for b in brands if b])
    else:
        normalized["Custom Brands"] = str(brands).strip()
    
    # Localized fields (FR, ZH-CN, ES)
    localized_prefixes = [
        ("Name", "Name"),
        ("Page Title", "Page Title"),
        ("Page Description", "Page Description"),
        ("Custom Brands", "Custom Brands")
    ]
    
    for base, field_prefix in localized_prefixes:
        for lang in [" - FR", " - ZH-CN", " - ES"]:
            field_name = f"{field_prefix}{lang}"
            normalized[field_name] = str(mapped_data.get(field_name, "")).strip()
    
    # Custom buttons (up to 2 buttons with localization)
    for btn_num in ["1", "2"]:
        # English
        normalized[f"Custom Button title {btn_num}"] = str(mapped_data.get(f"Custom Button title {btn_num}", "")).strip()
        normalized[f"Custom Button URL {btn_num}"] = validate_url(mapped_data.get(f"Custom Button URL {btn_num}", ""), base_url=base_url)
        
        # Localized
        for lang in [" - FR", " - ZH-CN", " - ES"]:
            title_key = f"Custom Button title {btn_num}{lang}"
            url_key = f"Custom Button URL {btn_num}{lang}"
            normalized[title_key] = str(mapped_data.get(title_key, "")).strip()
            normalized[url_key] = validate_url(mapped_data.get(url_key, ""), base_url=base_url)
    
    return normalized


def batch_normalize(
    raw_data_list: List[Dict[str, Any]],
    field_mapping: Optional[Dict[str, Any]] = None,
    deduplicate: bool = True,
    geocode_missing: bool = True,
    allow_missing_coordinates: bool = False,
) -> Tuple[List[Dict[str, str]], List[Dict[str, str]]]:
    """
    Normalize a batch of locations with comprehensive deduplication.
    Attempts to geocode stores missing coordinates, then excludes stores without coordinates and logs them clearly.
    
    Args:
        raw_data_list: List of raw data dictionaries
        field_mapping: Optional field mapping
        deduplicate: If True, ensures unique handles and removes duplicates by name+address+city
        geocode_missing: If True, attempt to geocode stores missing coordinates (default: True)
        allow_missing_coordinates: If True, keep rows with empty Latitude/Longitude (e.g. dry-run text QA;
            production exports should leave this False so only mappable stores ship).
    
    Returns:
        Tuple of (normalized_list, excluded_stores).
        normalized_list: Kept records (deduplicated, with coordinates).
        excluded_stores: Dropped records with name, address, reason (missing coordinates).
    """
    existing_handles = set() if deduplicate else None
    normalized_list = []
    seen_combinations = set()  # Track name+address+city combinations
    excluded_stores = []  # Track stores excluded due to missing coordinates
    
    for raw_data in raw_data_list:
        normalized = normalize_location(raw_data, field_mapping, existing_handles)
        
        # Check if coordinates are missing (critical - store cannot be mapped without coordinates)
        lat = normalized.get("Latitude", "").strip()
        lon = normalized.get("Longitude", "").strip()
        
        # If coordinates are missing, try to geocode the address
        if (not lat or not lon) and geocode_missing:
            store_address = normalized.get("Address Line 1", "").strip()
            store_city = normalized.get("City", "").strip()
            store_state = normalized.get("State/Province/Region", "").strip()
            store_country = normalized.get("Country", "").strip()
            
            # Try geocoding if we have address information
            if store_address or store_city:
                geocoded = geocode_address(store_address, store_city, store_state, store_country)
                if geocoded:
                    lat, lon = geocoded
                    normalized["Latitude"] = f"{lat:.7f}"
                    normalized["Longitude"] = f"{lon:.7f}"
                    # Update lat/lon variables for the check below
                    lat = normalized["Latitude"]
                    lon = normalized["Longitude"]
        
        # If still no coordinates after geocoding attempt, exclude the store (unless dry-run / QA mode)
        if not lat or not lon:
            store_name = normalized.get("Name", "Unknown").strip()
            store_address = normalized.get("Address Line 1", "").strip()
            store_city = normalized.get("City", "").strip()
            store_country = normalized.get("Country", "").strip()
            
            # Build address string for logging
            address_parts = [store_address, store_city, store_country]
            address_str = ", ".join([p for p in address_parts if p])
            if not address_str:
                address_str = "Address not available"
            
            if not allow_missing_coordinates:
                excluded_stores.append({
                    "name": store_name,
                    "address": address_str,
                    "reason": "Missing coordinates (Latitude/Longitude) - geocoding failed or insufficient address data"
                })
                continue  # Skip this store - exclude from output
        
        # Deduplicate by geography (rounded coords + country) or address fingerprint + city + country.
        # Name is intentionally excluded from the key — two entries for the same physical place under
        # different names should collapse; two same-named stores at different locations should not.
        if deduplicate:
            _lat_str = normalized.get("Latitude", "").strip()
            _lon_str = normalized.get("Longitude", "").strip()
            _addr_fp = re.sub(r'[^a-z0-9]', '', normalized.get("Address Line 1", "").strip().lower())
            _city_norm = re.sub(r'[^a-z0-9]', '', normalized.get("City", "").strip().lower())
            _country_norm = normalized.get("Country", "").strip().lower()
            try:
                _lat_r = round(float(_lat_str), 5)
                _lon_r = round(float(_lon_str), 5)
                combo_key = f"geo|{_lat_r}|{_lon_r}|{_country_norm}"
            except (ValueError, TypeError):
                if _addr_fp and _city_norm:
                    combo_key = f"addr|{_addr_fp}|{_city_norm}|{_country_norm}"
                else:
                    combo_key = None
            if not combo_key:
                _h = normalized.get("Handle", "").strip().lower()
                if _h:
                    combo_key = f"handle|{_h}"
            if combo_key:
                if combo_key in seen_combinations:
                    continue
                seen_combinations.add(combo_key)
        
        normalized_list.append(normalized)
    
    # Log excluded stores clearly (flush immediately so it appears in scraper output)
    if excluded_stores:
        import sys
        print("\n" + "=" * 80, flush=True)
        print(f"⚠️  EXCLUDED STORES (Missing Coordinates): {len(excluded_stores)} store(s)", flush=True)
        print("=" * 80, flush=True)
        print("These stores were excluded because they lack Latitude/Longitude coordinates.", flush=True)
        print("This may indicate closed stores, old data, or incomplete records.", flush=True)
        print("Please verify these stores manually:\n", flush=True)
        
        for i, store in enumerate(excluded_stores, 1):
            print(f"{i}. Store Name: {store['name']}", flush=True)
            print(f"   Address: {store['address']}", flush=True)
            print(f"   Reason: {store['reason']}", flush=True)
            print(flush=True)
        
        print("=" * 80, flush=True)
        print(flush=True)
    
    return normalized_list, excluded_stores


# CSV I/O FUNCTIONS

def write_normalized_csv(data: List[Dict[str, str]], filename: str = "output/locations.csv"):
    """
    Write normalized data to CSV using the canonical schema with Unix line endings
    
    Args:
        data: List of normalized location dictionaries
        filename: Output CSV file path
    """
    os.makedirs(os.path.dirname(filename) if os.path.dirname(filename) else '.', exist_ok=True)
    
    # Write CSV with standard newline handling
    with open(filename, 'w', newline='', encoding='utf-8') as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=SCHEMA, lineterminator='\n')
        writer.writeheader()
        for row in data:
            writer.writerow(row)
    
    # Post-process to ensure Unix line endings (\n only, no \r\n)
    # This is necessary because csv module may still write \r\n on some systems
    with open(filename, 'rb') as f:
        content = f.read()
    content = content.replace(b'\r\n', b'\n')  # Convert Windows to Unix
    with open(filename, 'wb') as f:
        f.write(content)
    
    print(f"✅ Exported {len(data)} normalized locations to {filename}")


def read_csv_to_dict(filename: str) -> List[Dict[str, str]]:
    """Read a CSV file into a list of dictionaries. Returns [] if file does not exist."""
    if not os.path.exists(filename):
        return []
    with open(filename, 'r', newline='', encoding='utf-8') as csvfile:
        reader = csv.DictReader(csvfile)
        return list(reader)


# EXAMPLE USAGE

if __name__ == "__main__":
    # Example 1: Normalize with direct field names
    print("Example 1: Direct normalization")
    raw_store = {
        "Name": "Example Watch Store",
        "Address Line 1": "123 Main St",
        "City": "New York",
        "Country": "USA",
        "Latitude": "40.7128",
        "Longitude": "-74.0060",
        "Phone": "555.123.4567",
        "Status": "1"
    }
    
    normalized = normalize_location(raw_store)
    print(f"  Name: {normalized['Name']}")
    print(f"  Handle: {normalized['Handle']}")
    print(f"  Phone: {normalized['Phone']}")
    print(f"  Status: {normalized['Status']}")
    print(f"  Coords: {normalized['Latitude']}, {normalized['Longitude']}")
    
    # Example 2: Normalize with field mapping
    print("\nExample 2: With field mapping")
    raw_api_data = {
        "store_name": "Another Store",
        "street": "456 Oak Ave",
        "city_name": "Boston",
        "lat": 42.3601,
        "lng": -71.0589,
        "is_active": True
    }
    
    field_mapping = {
        "Name": "store_name",
        "Address Line 1": "street",
        "City": "city_name",
        "Latitude": "lat",
        "Longitude": "lng",
        "Status": "is_active"
    }
    
    normalized2 = normalize_location(raw_api_data, field_mapping)
    print(f"  Name: {normalized2['Name']}")
    print(f"  Handle: {normalized2['Handle']}")
    print(f"  Address: {normalized2['Address Line 1']}, {normalized2['City']}")
    print(f"  Coords: {normalized2['Latitude']}, {normalized2['Longitude']}")
    
    # Example 3: Batch normalization
    print("\nExample 3: Batch normalization")
    batch_data = [raw_store, raw_api_data]
    normalized_batch, excluded = batch_normalize(batch_data, field_mapping=None)
    print(f"  Normalized {len(normalized_batch)} locations")
    print(f"  Handles: {[loc['Handle'] for loc in normalized_batch]}")

