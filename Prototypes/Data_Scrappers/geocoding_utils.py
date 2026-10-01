#!/usr/bin/env python3
"""Geocoding via Nominatim (OpenStreetMap). Used by data_normalizer."""

import time
from typing import Optional, Tuple

try:
    from geopy.geocoders import Nominatim
    from geopy.exc import GeocoderTimedOut, GeocoderServiceError, GeocoderUnavailable
    GEOPY_AVAILABLE = True
except ImportError:
    GEOPY_AVAILABLE = False
    Nominatim = None
    GeocoderTimedOut = GeocoderServiceError = GeocoderUnavailable = Exception

GEOCODER_USER_AGENT = "WatchDNA-StoreLocator/1.0 (https://watchdna.com)"
GEOCODER_TIMEOUT = 10
RATE_LIMIT_DELAY_SECONDS = 1.0

_geocoder = None
_last_geocode_time = 0.0
_geocode_cache: dict = {}


def get_geocoder():
    global _geocoder
    if not GEOPY_AVAILABLE or Nominatim is None:
        return None

    if _geocoder is None:
        _geocoder = Nominatim(
            user_agent=GEOCODER_USER_AGENT,
            timeout=GEOCODER_TIMEOUT
        )

    return _geocoder


def geocode_address(
    address: str,
    city: str = "",
    state: str = "",
    country: str = ""
) -> Optional[Tuple[float, float]]:
    if not GEOPY_AVAILABLE:
        return None

    address_parts = [p for p in (address, city, state, country) if p]
    if not address_parts:
        return None

    full_address = ", ".join(address_parts)
    cache_key = full_address.lower().strip()

    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    geocoder = get_geocoder()
    if not geocoder:
        return None

    global _last_geocode_time
    current_time = time.time()
    time_since_last = current_time - _last_geocode_time
    if time_since_last < RATE_LIMIT_DELAY_SECONDS:
        time.sleep(RATE_LIMIT_DELAY_SECONDS - time_since_last)

    try:
        _last_geocode_time = time.time()
        location = geocoder.geocode(full_address, exactly_one=True, timeout=GEOCODER_TIMEOUT)

        if location:
            result = (location.latitude, location.longitude)
            _geocode_cache[cache_key] = result
            return result

        _geocode_cache[cache_key] = None
        return None

    except (GeocoderTimedOut, GeocoderServiceError, GeocoderUnavailable):
        _geocode_cache[cache_key] = None
        return None
    except Exception:
        _geocode_cache[cache_key] = None
        return None
