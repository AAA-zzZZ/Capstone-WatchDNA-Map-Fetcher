#!/usr/bin/env python3
"""Shared coordinate validation for data_normalizer and pattern_detector."""

import math
from typing import Any, Optional

EARTH_RADIUS_METERS = 6371000


def validate_coordinate_value(value: Any, coord_type: str = "latitude") -> Optional[float]:
    if value is None or value == "":
        return None

    try:
        coord = float(str(value).strip())

        if not math.isfinite(coord):
            return None

        if coord_type.lower() == "latitude":
            if not (-90 <= coord <= 90):
                return None
        else:
            if not (-180 <= coord <= 180):
                return None

        return coord
    except (ValueError, TypeError):
        return None


def normalize_coordinate_string(value: Any, coord_type: str = "latitude") -> str:
    coord = validate_coordinate_value(value, coord_type)
    return f"{coord:.7f}" if coord is not None else ""
