#!/usr/bin/env python3
"""
CSV Validator for WatchDNA Store Locator
Validates CSV files for header correctness and row-level data quality.

Two entry points:
  - validate_csv(path): Lightweight boolean check for programmatic use. Returns True/False.
  - CSVValidator: Full validation with auto-fix, duplicate detection, and detailed reports.
    Use validate_file() for file validation, or --check-urls for HTTP URL verification.

Can be used as:
  1. CLI tool: python validate_csv.py locations.csv
  2. Module: from validate_csv import validate_csv, CSVValidator, DEFAULT_REQUIRED
"""

import csv
import sys
import math
import json
import argparse
import os
import re
from pathlib import Path
from typing import List, Dict, Tuple, Set, Any, Optional
from collections import defaultdict

from scraper_utils import resolve_partial_url
from country_normalize import normalize_country
from urllib.parse import urlparse

# Handle Windows console encoding
if sys.platform == 'win32':
    # Try to set UTF-8 encoding for Windows console
    try:
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except:
        pass


# All known headers from locations.csv schema
ALL_HEADERS = [
    "Handle", "Name", "Status", "Address Line 1", "Address Line 2",
    "Postal/ZIP Code", "City", "State/Province/Region", "Country",
    "Phone", "Email", "Website", "Image URL",
    "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
    "Page Title", "Page Description", "Meta Title", "Meta Description",
    "Latitude", "Longitude", "Priority",
    "Name - FR", "Page Title - FR", "Page Description - FR",
    "Name - ZH-CN", "Page Title - ZH-CN", "Page Description - ZH-CN",
    "Name - ES", "Page Title - ES", "Page Description - ES",
    " Tags", "Tags",  # Note: has leading space in actual CSV, include both
    "Custom Brands", "Custom Brands - FR", "Custom Brands - ZH-CN", "Custom Brands - ES",
    "Custom Button title 1", "Custom Button title 1 - FR", "Custom Button title 1 - ZH-CN", "Custom Button title 1 - ES",
    "Custom Button URL 1", "Custom Button URL 1 - FR", "Custom Button URL 1 - ZH-CN", "Custom Button URL 1 - ES",
    "Custom Button title 2", "Custom Button title 2 - FR", "Custom Button title 2 - ZH-CN", "Custom Button title 2 - ES",
    "Custom Button URL 2", "Custom Button URL 2 - FR", "Custom Button URL 2 - ZH-CN", "Custom Button URL 2 - ES"
]

# Default required headers
# Core required fields (must be present and non-empty in all CSVs):
# - Handle, Name, Status, Address Line 1, City, Country, Latitude, Longitude
# Optional fields (can be empty in scraped CSVs, filled later):
# - Postal/ZIP Code, State/Province/Region (often empty for international stores)
# - Page Title (auto-generated or filled later)
# - Custom Brands (added during master CSV merge process)
DEFAULT_REQUIRED = ["Handle", "Name", "Status", "Address Line 1", "City", "Country", "Latitude", "Longitude"]
REQUIRED = {"Handle", "Name", "Status", "Address Line 1", "City", "Country", "Latitude", "Longitude"}

# Matches backend `isRowCompleteForDb`: name, address (Line 1 or Line 2), and coordinates are required;
# phone is optional — stores without a phone can be added and updated later.
DEFAULT_REQUIRED_DB_IMPORT = ["Handle", "Name", "Status", "City", "Country", "Latitude", "Longitude"]

# Default duplicate key fields
DEFAULT_DUPLICATE_KEY = ["Name", "Address Line 1", "City"]

# Exit codes
EXIT_OK = 0
EXIT_USAGE = 1
EXIT_SCHEMA = 2
EXIT_DATA = 3
EXIT_EXCEPTION = 4


def _lowercase_http_url_scheme(url_str: str) -> str:
    """Normalize http(s) scheme to lowercase for consistent storage (e.g. HTTP:// -> http://)."""
    if not url_str:
        return url_str
    s = str(url_str).strip()
    m = re.match(r"(?i)^(https?)(://.*)$", s)
    if m:
        return m.group(1).lower() + m.group(2)
    return s


def fix_common_url_scheme_issues(url_str: str) -> str:
    """
    Insert missing // after http: or https: when a host or path follows immediately
    (e.g. https:www.example.com -> https://www.example.com).
    Normalizes http/https scheme to lowercase.
    """
    if not url_str:
        return url_str
    s = str(url_str).strip()
    if re.match(r"(?i)^https?://", s):
        return _lowercase_http_url_scheme(s)
    m = re.match(r"(?i)^(https?:)(?!//)(.+)$", s)
    if m:
        scheme = m.group(1).lower()
        return _lowercase_http_url_scheme(f"{scheme}//{m.group(2)}")
    return s

# Warnings
MAX_ROWS_WARNING = 10000
COORDINATE_PRECISION_WARNING = 7


class ValidationError:
    """Represents a validation error"""
    def __init__(self, row: int, field: str, issue: str, value: Any = None):
        self.row = row
        self.field = field
        self.issue = issue
        self.value = value

    def to_dict(self) -> Dict[str, Any]:
        d = {"row": self.row, "field": self.field, "issue": self.issue}
        if self.value is not None:
            d["value"] = str(self.value)
        return d

    def __str__(self) -> str:
        if self.value is not None:
            return f"Row {self.row}: {self.field}: {self.issue} (value: {self.value})"
        return f"Row {self.row}: {self.field}: {self.issue}"


class ValidationWarning:
    """Represents a validation warning"""
    def __init__(self, warning_type: str, message: str, details: Optional[Dict[str, Any]] = None):
        self.warning_type = warning_type
        self.message = message
        self.details = details or {}

    def to_dict(self) -> Dict[str, Any]:
        d = {"type": self.warning_type, "message": self.message}
        d.update(self.details)
        return d

    def __str__(self) -> str:
        return self.message


class CSVValidator:
    """Main CSV validator class"""

    def __init__(self,
                 required_headers: List[str],
                 warn_duplicates: bool = True,
                 fail_duplicates: bool = False,
                 show_bad: bool = False,
                 limit: Optional[int] = None,
                 max_rows: Optional[int] = MAX_ROWS_WARNING,
                 check_urls: bool = False,
                 db_import_parity: bool = False):
        self.required_headers = required_headers
        self.warn_duplicates = warn_duplicates
        self.fail_duplicates = fail_duplicates
        self.show_bad = show_bad
        self.limit = limit
        self.max_rows = max_rows
        self.check_urls = check_urls  # If True, validate URLs via HTTP requests
        self.db_import_parity = db_import_parity

        self.errors: List[ValidationError] = []
        self.warnings: List[ValidationWarning] = []
        self.rows_checked = 0
        self.file_path = ""
        self.fixes_applied = 0

    def validate_headers(self, fieldnames: List[str]) -> bool:
        """Validate CSV headers. Returns True if valid, False otherwise."""
        # Check for duplicate headers
        seen = set()
        duplicates = []
        for header in fieldnames:
            if header in seen:
                duplicates.append(header)
            seen.add(header)

        if duplicates:
            print(f"❌ Duplicate headers found: {', '.join(duplicates)}")
            return False

        # Check for missing required headers
        missing = [h for h in self.required_headers if h not in fieldnames]
        if missing:
            print(f"❌ Missing required headers: {', '.join(missing)}")
            return False

        # Note any unknown headers (not in ALL_HEADERS)
        unknown = [h for h in fieldnames if h not in ALL_HEADERS]
        if unknown:
            self.warnings.append(ValidationWarning(
                "unknown_headers",
                f"Unknown headers (not in schema): {', '.join(unknown)}",
                {"headers": unknown}
            ))

        return True

    def validate_coordinate(self, value: str, is_latitude: bool) -> Tuple[bool, Optional[float], Optional[str]]:
        """
        Validate a coordinate value.
        Returns: (is_valid, parsed_value, error_message)
        """
        if not value or value.strip() == "":
            return False, None, "empty"

        try:
            coord = float(value)

            # Check for NaN or infinity
            if math.isnan(coord) or math.isinf(coord):
                return False, None, "invalid_number"

            # Range check
            if is_latitude:
                if not (-90 <= coord <= 90):
                    return False, coord, "out_of_range"
            else:  # longitude
                if not (-180 <= coord <= 180):
                    return False, coord, "out_of_range"

            return True, coord, None

        except (ValueError, TypeError):
            return False, None, "not_a_number"

    def check_coordinate_precision(self, value: float, field: str, row_num: int):
        """Warn if coordinate has too many decimal places"""
        str_value = str(value)
        if '.' in str_value:
            decimals = len(str_value.split('.')[1])
            if decimals > COORDINATE_PRECISION_WARNING:
                self.warnings.append(ValidationWarning(
                    "precision",
                    f"Row {row_num}: {field} has {decimals} decimal places (>{COORDINATE_PRECISION_WARNING})",
                    {"row": row_num, "field": field, "decimals": decimals}
                ))

    def validate_url(self, value: str, field: str, row_num: int, check_http: bool = False,
                     url_base: Optional[str] = None) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Validate a URL value.
        Resolves relative store-detail paths using url_base when provided.
        Optionally checks if URL is accessible via HTTP.
        Returns: (is_valid, normalized_url, error_message)
        """
        if not value or value.strip() == "":
            return True, "", None  # Empty URLs are valid (optional field)
        url_str = str(value).strip()
        url_str = url_str.replace('\\/', '/').replace('\\', '/')
        url_str = fix_common_url_scheme_issues(url_str)
        url_str = resolve_partial_url(url_str, url_base)
        if url_str and not urlparse(url_str).scheme:
            url_str = f"https://{url_str}"
        parsed = urlparse(url_str)
        if not (parsed.scheme and parsed.netloc):
            return False, None, "invalid_format"
        url_str = _lowercase_http_url_scheme(url_str)
        if check_http:
            try:
                import requests
                response = requests.head(url_str, timeout=5, allow_redirects=True)
                if response.status_code >= 400:
                    response = requests.get(url_str, timeout=5, allow_redirects=True, stream=True)
                    if response.status_code >= 400:
                        return False, url_str, f"http_error_{response.status_code}"
            except requests.exceptions.Timeout:
                return False, url_str, "timeout"
            except requests.exceptions.RequestException:
                return False, url_str, "connection_error"
            except Exception:
                pass
        return True, url_str, None

    def fix_data_quality(self, value: str, field: str) -> str:
        """
        Fix common data quality issues in a field value.
        Returns the cleaned value.
        """
        if not value:
            return value
        
        original = value

        # Normalize country codes / aliases to canonical full name
        if field == "Country":
            normalized = normalize_country(value)
            if normalized != value:
                return normalized

        # Fix backslashes in text fields (convert to forward slashes or spaces)
        if field not in ["Website", "Image URL"]:
            # Replace backslashes with forward slashes in addresses (e.g., "1\F" -> "1/F")
            if '\\' in value:
                # Check if it's a pattern like "1\F" or "Shop 1\2" - convert to forward slash
                if re.search(r'\d+\\[A-Z]', value) or re.search(r'\\\s*[A-Z]', value):
                    value = value.replace('\\', '/')
                # Check if it's trailing backslashes - remove them
                elif value.rstrip().endswith('\\'):
                    value = value.rstrip('\\').strip()
                # Otherwise, replace with space or forward slash based on context
                else:
                    # Replace backslash sequences with single forward slash
                    value = re.sub(r'\\+', '/', value)
                    # Clean up multiple slashes
                    value = re.sub(r'/+', '/', value)
        
        # Remove control characters (except newlines/tabs in addresses)
        if field not in ["Address Line 1", "Address Line 2"]:
            # Remove control characters except newline, tab, carriage return
            value = ''.join(c for c in value if ord(c) >= 32 or c in ['\n', '\t', '\r'])
        
        # Clean up excessive whitespace
        value = re.sub(r'\s+', ' ', value).strip()
        
        # Remove trailing backslashes from names
        if field == "Name":
            value = value.rstrip('\\').strip()
        
        return value

    def check_data_quality(self, row: Dict[str, str], row_num: int, auto_fix: bool = False):
        """
        Check for data quality issues like backslashes, weird numbers in names, etc.
        Adds warnings for issues found. If auto_fix is True, fixes issues in place.
        """
        # Text fields that should not contain backslashes
        text_fields = ["Name", "Address Line 1", "Address Line 2", "City", 
                      "State/Province/Region", "Country", "Page Title", "Page Description"]
        
        for field in text_fields:
            value = row.get(field, "").strip()
            if not value:
                continue
            
            original_value = value
            
            # Auto-fix if enabled
            if auto_fix:
                fixed_value = self.fix_data_quality(value, field)
                if fixed_value != original_value:
                    row[field] = fixed_value
                    value = fixed_value
            
            # Warn when Country looks like a code / alias that will be normalized
            if field == "Country" and not auto_fix:
                normalized_country = normalize_country(value)
                if normalized_country and normalized_country != value:
                    self.warnings.append(ValidationWarning(
                        "country_not_canonical",
                        f"Row {row_num}: Country '{value}' should be '{normalized_country}' (run --fix to correct)",
                        {"row": row_num, "field": field, "value": value, "canonical": normalized_country}
                    ))

            # Check for backslashes (except in URLs where they might be valid)
            if '\\' in value and field not in ["Website", "Image URL"]:
                self.warnings.append(ValidationWarning(
                    "backslash_in_text",
                    f"Row {row_num}: {field} contains backslash: {value[:50]}...",
                    {"row": row_num, "field": field, "value": value[:100], "original": original_value}
                ))
            
            # Check for weird patterns in Name field
            if field == "Name":
                # Check for names that are just numbers or start with numbers followed by spaces
                name_clean = value.strip()
                # Check if name is just digits (like "000000006")
                if name_clean.isdigit() and len(name_clean) > 3:
                    self.warnings.append(ValidationWarning(
                        "numeric_name",
                        f"Row {row_num}: Name appears to be just numbers: {name_clean}",
                        {"row": row_num, "field": field, "value": name_clean}
                    ))
                
                # Check for names ending with just backslashes
                if name_clean.endswith('\\') or name_clean.endswith('\\\\'):
                    self.warnings.append(ValidationWarning(
                        "trailing_backslash",
                        f"Row {row_num}: Name ends with backslash: {name_clean}",
                        {"row": row_num, "field": field, "value": name_clean}
                    ))
                
                # Check for names that are mostly backslashes
                if name_clean.count('\\') > len(name_clean) * 0.3:  # More than 30% backslashes
                    self.warnings.append(ValidationWarning(
                        "excessive_backslashes",
                        f"Row {row_num}: Name contains excessive backslashes: {name_clean[:50]}...",
                        {"row": row_num, "field": field, "value": name_clean[:100]}
                    ))
            
            # Check for control characters (except newlines/tabs in multi-line fields)
            if field in ["Address Line 1", "Address Line 2"]:
                # Allow newlines in addresses
                pass
            else:
                # Check for control characters
                has_control = any(ord(c) < 32 and c not in ['\n', '\t', '\r'] for c in value)
                if has_control:
                    self.warnings.append(ValidationWarning(
                        "control_characters",
                        f"Row {row_num}: {field} contains control characters",
                        {"row": row_num, "field": field}
                    ))

    def validate_row(self, row: Dict[str, str], row_num: int) -> bool:
        """
        Validate a single data row.
        Returns True if valid, False if errors found.
        """
        has_errors = False

        # Validate required fields are non-empty
        for field in self.required_headers:
            value = row.get(field, "").strip()
            if not value:
                self.errors.append(ValidationError(row_num, field, "empty"))
                has_errors = True

        if self.db_import_parity:
            a1 = row.get("Address Line 1", "").strip()
            a2 = row.get("Address Line 2", "").strip()
            if not a1 and not a2:
                self.errors.append(
                    ValidationError(
                        row_num,
                        "Address Line 1",
                        "need_address_line_1_or_2",
                    )
                )
                has_errors = True

        # Validate Latitude
        lat_valid, lat_value, lat_error = self.validate_coordinate(
            row.get("Latitude", ""), is_latitude=True
        )
        if not lat_valid:
            self.errors.append(ValidationError(
                row_num, "Latitude", lat_error, row.get("Latitude", "")
            ))
            has_errors = True
        elif lat_value is not None:
            self.check_coordinate_precision(lat_value, "Latitude", row_num)

        # Validate Longitude
        lon_valid, lon_value, lon_error = self.validate_coordinate(
            row.get("Longitude", ""), is_latitude=False
        )
        if not lon_valid:
            self.errors.append(ValidationError(
                row_num, "Longitude", lon_error, row.get("Longitude", "")
            ))
            has_errors = True
        elif lon_value is not None:
            self.check_coordinate_precision(lon_value, "Longitude", row_num)

        # Validate Website URL (if present)
        website = row.get("Website", "").strip()
        if website:
            url_valid, normalized_url, url_error = self.validate_url(
                website, "Website", row_num, check_http=self.check_urls
            )
            if not url_valid:
                self.errors.append(ValidationError(
                    row_num, "Website", url_error or "invalid_url", website
                ))
                has_errors = True
            elif normalized_url and normalized_url != website:
                row["Website"] = normalized_url
                self.warnings.append(ValidationWarning(
                    "url_normalized",
                    f"Row {row_num}: Website URL normalized: {website} -> {normalized_url}",
                    {"row": row_num, "field": "Website", "original": website, "normalized": normalized_url}
                ))

        # Validate Image URL (if present)
        image_url = row.get("Image URL", "").strip()
        if image_url:
            url_valid, normalized_url, url_error = self.validate_url(
                image_url, "Image URL", row_num, check_http=self.check_urls
            )
            if not url_valid:
                self.errors.append(ValidationError(
                    row_num, "Image URL", url_error or "invalid_url", image_url
                ))
                has_errors = True
            elif normalized_url and normalized_url != image_url:
                row["Image URL"] = normalized_url
                self.warnings.append(ValidationWarning(
                    "url_normalized",
                    f"Row {row_num}: Image URL normalized: {image_url} -> {normalized_url}",
                    {"row": row_num, "field": "Image URL", "original": image_url, "normalized": normalized_url}
                ))

        # Check data quality issues (warnings, not errors)
        # Note: auto_fix is handled at the file level, not row level
        self.check_data_quality(row, row_num, auto_fix=False)

        # If show_bad is enabled and there are errors, print the full row
        if has_errors and self.show_bad:
            print(f"\nFull row {row_num} content:")
            for key, value in row.items():
                print(f"  {key}: {value}")

        return not has_errors

    def detect_duplicates(self, rows: List[Dict[str, str]]) -> List[Tuple[Tuple[str, ...], List[int]]]:
        """
        Detect duplicate rows based on key fields.
        Returns list of (key_tuple, [row_numbers])
        """
        key_fields = DEFAULT_DUPLICATE_KEY
        duplicates_map: Dict[Tuple[str, ...], List[int]] = defaultdict(list)

        for idx, row in enumerate(rows, start=2):  # Start at 2 (after header)
            # Build key tuple from key fields
            key = tuple(row.get(field, "").strip() for field in key_fields)

            # Only track if all key fields are non-empty
            if all(k for k in key):
                duplicates_map[key].append(idx)

        # Return only keys that have duplicates
        return [(key, rows) for key, rows in duplicates_map.items() if len(rows) > 1]

    def dedupe_rows_by_key(
        self, rows: List[Dict[str, str]], key_fields: List[str]
    ) -> Tuple[List[Dict[str, str]], int]:
        """
        Keep the first row for each non-empty key tuple; drop subsequent duplicates.
        Rows with any empty key field are always kept (not deduped).
        """
        seen: Set[Tuple[str, ...]] = set()
        out: List[Dict[str, str]] = []
        removed = 0
        for row in rows:
            key = tuple((row.get(f) or "").strip() for f in key_fields)
            if all(key):
                if key in seen:
                    removed += 1
                    continue
                seen.add(key)
            out.append(row)
        return out, removed

    def remove_duplicates_from_file(self, file_path: str, output_path: str = None) -> int:
        """
        Remove duplicate rows from a CSV file, keeping the first occurrence.
        
        Args:
            file_path: Path to input CSV file
            output_path: Path to output CSV file (defaults to overwriting input)
        
        Returns:
            Number of duplicates removed
        """
        if output_path is None:
            output_path = file_path
        
        key_fields = DEFAULT_DUPLICATE_KEY
        seen_keys = set()
        unique_rows = []
        duplicates_removed = 0
        
        try:
            with open(file_path, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                headers = reader.fieldnames
                
                if not headers:
                    print(f"❌ No headers found in {file_path}")
                    return 0
                
                for row in reader:
                    # Build key tuple from key fields
                    key = tuple(row.get(field, "").strip() for field in key_fields)
                    
                    # Only check for duplicates if all key fields are non-empty
                    if all(k for k in key):
                        if key in seen_keys:
                            duplicates_removed += 1
                            continue
                        seen_keys.add(key)
                    
                    unique_rows.append(row)
            
            # Write back to file with Unix line endings
            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=headers, lineterminator='\n')
                writer.writeheader()
                writer.writerows(unique_rows)
            
            # Post-process to ensure Unix line endings (\n only)
            with open(output_path, 'rb') as f:
                content = f.read()
            content = content.replace(b'\r\n', b'\n')
            with open(output_path, 'wb') as f:
                f.write(content)
            
            return duplicates_removed
            
        except Exception as e:
            print(f"❌ Error removing duplicates: {e}")
            return 0

    def fix_file_data_quality(self, file_path: str, output_path: str = None) -> int:
        """
        Fix data quality issues in a CSV file.
        Returns the number of fixes applied.
        """
        if output_path is None:
            output_path = file_path
        
        fixes_count = 0
        
        try:
            with open(file_path, 'r', encoding='utf-8-sig') as f:
                reader = csv.DictReader(f)
                headers = reader.fieldnames
                
                if not headers:
                    return 0
                
                rows = list(reader)
                
                # Fix each row
                for row in rows:
                    for field in headers:
                        if field in row:
                            original = row[field]
                            fixed = self.fix_data_quality(row[field], field)
                            if fixed != original:
                                row[field] = fixed
                                fixes_count += 1
                    # Also normalize URLs (Website and Image URL)
                    for url_field in ["Website", "Image URL"]:
                        if url_field in headers and url_field in row:
                            url_value = row[url_field].strip()
                            if url_value:
                                url_valid, normalized_url, _ = self.validate_url(
                                    url_value, url_field, 0, check_http=False
                                )
                                if normalized_url and normalized_url != url_value:
                                    row[url_field] = normalized_url
                                    fixes_count += 1
            
            # Write fixed data back
            with open(output_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.DictWriter(f, fieldnames=headers, lineterminator='\n')
                writer.writeheader()
                writer.writerows(rows)
            
            # Post-process to ensure Unix line endings
            with open(output_path, 'rb') as f:
                content = f.read()
            content = content.replace(b'\r\n', b'\n')
            with open(output_path, 'wb') as f:
                f.write(content)
            
            return fixes_count
            
        except Exception as e:
            print(f"❌ Error fixing file: {e}")
            return 0

    def validate_file(self, file_path: str, auto_fix: bool = False) -> int:
        """
        Validate a CSV file.
        Returns exit code.
        """
        self.file_path = file_path

        # Check if file exists
        if not Path(file_path).exists():
            print(f"❌ File not found: {file_path}")
            return EXIT_USAGE

        try:
            with open(file_path, 'r', newline='', encoding='utf-8') as f:
                reader = csv.DictReader(f)

                # Validate headers
                print("=" * 60)
                print("CSV VALIDATION")
                print("=" * 60)
                print(f"File: {file_path}")
                print()

                if reader.fieldnames is None:
                    print("❌ Empty file or no headers found")
                    return EXIT_SCHEMA

                print(f"Headers found: {len(reader.fieldnames)}")
                if not self.validate_headers(reader.fieldnames):
                    return EXIT_SCHEMA

                print("✅ Header validation passed")
                print()

                # Read all rows into memory (needed for duplicate detection)
                all_rows = list(reader)
                total_rows = len(all_rows)

                # Check for empty file
                if total_rows == 0:
                    self.warnings.append(ValidationWarning(
                        "empty_file",
                        "No data rows found in file"
                    ))

                # Check for suspiciously large files
                if self.max_rows and total_rows > self.max_rows:
                    self.warnings.append(ValidationWarning(
                        "large_file",
                        f"File has {total_rows} rows (>{self.max_rows})",
                        {"rows": total_rows, "threshold": self.max_rows}
                    ))

                # Auto-fix data quality issues if requested
                dedup_removed = 0
                if auto_fix:
                    print("🔧 Auto-fixing data quality issues...")
                    fixes_count = 0
                    for row in all_rows:
                        for field in reader.fieldnames:
                            if field in row:
                                original = row[field]
                                fixed = self.fix_data_quality(row[field], field)
                                if fixed != original:
                                    row[field] = fixed
                                    fixes_count += 1
                        # Also normalize URLs (Website and Image URL)
                        for url_field in ["Website", "Image URL"]:
                            if url_field in reader.fieldnames and url_field in row:
                                url_value = row[url_field].strip()
                                if url_value:
                                    url_valid, normalized_url, _ = self.validate_url(
                                        url_value, url_field, 0, check_http=False
                                    )
                                    if normalized_url and normalized_url != url_value:
                                        row[url_field] = normalized_url
                                        fixes_count += 1

                    all_rows, dedup_removed = self.dedupe_rows_by_key(
                        all_rows, list(DEFAULT_DUPLICATE_KEY)
                    )
                    if dedup_removed > 0:
                        print(
                            f"✅ Removed {dedup_removed} duplicate row(s) "
                            f"(same {', '.join(DEFAULT_DUPLICATE_KEY)}, kept first)"
                        )
                        print()

                    if fixes_count > 0 or dedup_removed > 0:
                        # Write fixed data back to file
                        with open(file_path, 'w', newline='', encoding='utf-8') as f:
                            writer = csv.DictWriter(f, fieldnames=reader.fieldnames, lineterminator='\n')
                            writer.writeheader()
                            writer.writerows(all_rows)
                        
                        # Post-process to ensure Unix line endings
                        with open(file_path, 'rb') as f:
                            content = f.read()
                        content = content.replace(b'\r\n', b'\n')
                        with open(file_path, 'wb') as f:
                            f.write(content)
                        
                        if fixes_count > 0:
                            print(f"✅ Fixed {fixes_count} data quality issue(s)")
                            print()
                        
                        # Re-read the fixed file for validation
                        with open(file_path, 'r', newline='', encoding='utf-8') as f:
                            reader = csv.DictReader(f)
                            all_rows = list(reader)

                # Validate rows
                rows_to_check = all_rows[:self.limit] if self.limit else all_rows
                self.rows_checked = len(rows_to_check)

                print(f"Validating {self.rows_checked} rows...")
                print()

                for idx, row in enumerate(rows_to_check, start=2):
                    self.validate_row(row, idx)

                # Detect duplicates
                if self.warn_duplicates or self.fail_duplicates:
                    duplicates = self.detect_duplicates(all_rows)
                    for key, row_nums in duplicates:
                        key_str = ", ".join(f"{k}" for k in key)
                        message = f"Duplicate found: ({key_str}) in rows {row_nums}"

                        if self.fail_duplicates:
                            self.errors.append(ValidationError(
                                row_nums[0], "duplicate", message
                            ))
                        else:
                            self.warnings.append(ValidationWarning(
                                "duplicate",
                                message,
                                {"key": list(key), "rows": row_nums}
                            ))

                return EXIT_OK

        except IOError as e:
            print(f"❌ IO Error: {e}")
            return EXIT_EXCEPTION
        except Exception as e:
            print(f"❌ Unexpected error: {e}")
            import traceback
            traceback.print_exc()
            return EXIT_EXCEPTION

    def print_report(self, show_details: bool = True):
        """Print human-readable validation report with detailed information"""
        print("=" * 80)
        print("VALIDATION REPORT")
        print("=" * 80)
        print(f"Rows checked: {self.rows_checked}")
        print()

        if self.errors:
            print(f"❌ ERRORS ({len(self.errors)}):")
            print("-" * 80)
            
            # Group errors by type
            error_groups = {}
            for error in self.errors:
                error_type = error.issue
                if error_type not in error_groups:
                    error_groups[error_type] = []
                error_groups[error_type].append(error)
            
            for error_type, errors in error_groups.items():
                print(f"\n{error_type.upper().replace('_', ' ')} ({len(errors)} occurrence(s)):")
                for error in errors[:20]:  # Show first 20 of each type
                    value_preview = f" (value: {error.value})" if error.value else ""
                    print(f"  Row {error.row}: {error.field}{value_preview}")
                if len(errors) > 20:
                    print(f"  ... and {len(errors) - 20} more")
            print()

        if self.warnings:
            print(f"⚠️  WARNINGS ({len(self.warnings)}):")
            print("-" * 80)
            
            # Group warnings by type
            warning_groups = {}
            for warning in self.warnings:
                warning_type = warning.warning_type
                if warning_type not in warning_groups:
                    warning_groups[warning_type] = []
                warning_groups[warning_type].append(warning)
            
            for warning_type, warnings in warning_groups.items():
                print(f"\n{warning_type.upper().replace('_', ' ')} ({len(warnings)} occurrence(s)):")
                for warning in warnings[:20]:  # Show first 20 of each type
                    details = warning.details
                    row = details.get('row', '?')
                    field = details.get('field', '?')
                    value = details.get('value', '')
                    value_preview = f": {value[:60]}..." if value else ""
                    print(f"  Row {row}: {field}{value_preview}")
                if len(warnings) > 20:
                    print(f"  ... and {len(warnings) - 20} more")
            print()

        print("=" * 80)
        if self.errors:
            print(f"❌ VALIDATION FAILED: {len(self.errors)} error(s), {len(self.warnings)} warning(s)")
        else:
            if self.warnings:
                print(f"✅ VALIDATION PASSED with {len(self.warnings)} warning(s)")
            else:
                print("✅ VALIDATION PASSED")
        print("=" * 80)

    def get_json_report(self) -> Dict[str, Any]:
        """Generate JSON validation report"""
        status = "failed" if self.errors else "ok"
        exit_code = EXIT_DATA if self.errors else EXIT_OK

        return {
            "file": self.file_path,
            "rows_checked": self.rows_checked,
            "errors": [e.to_dict() for e in self.errors],
            "warnings": [w.to_dict() for w in self.warnings],
            "status": status,
            "exit_code": exit_code
        }


# SIMPLE VALIDATE_CSV FUNCTION (for module imports from dynamic_scraper.py)

def validate_csv(path="locations.csv"):
    """
    Simple validation function for use as an importable module.
    Returns True if valid, False otherwise.
    
    This is used by dynamic_scraper.py for quick validation.
    For comprehensive validation, use the CLI tool or CSVValidator class.
    """
    try:
        with open(path, newline='', encoding="utf-8") as f:
            r = csv.DictReader(f)
            missing = [h for h in REQUIRED if h not in r.fieldnames]
            extra = [h for h in r.fieldnames if h not in ALL_HEADERS]
            if missing: 
                print("❌ Missing headers:", missing)
                return False
            if extra:
                print("⚠️ Extra headers (ok but check):", extra)
            bad = 0
            warnings_count = 0
            for i, row in enumerate(r, start=2):
                # Check required fields are non-empty
                for field in REQUIRED:
                    value = row.get(field, "").strip()
                    if not value:
                        print(f"❌ Row {i}: {field} is empty ({row.get('Name', 'N/A')})")
                        bad += 1
                
                # Validate coordinates
                lat, lon = row.get("Latitude", ""), row.get("Longitude", "")
                try:
                    lat_f, lon_f = float(lat), float(lon)
                    if not (-90 <= lat_f <= 90 and -180 <= lon_f <= 180) or math.isnan(lat_f) or math.isnan(lon_f):
                        raise ValueError()
                except Exception:
                    print(f"❌ Row {i}: invalid coords → {lat},{lon} ({row.get('Name', '')})")
                    bad += 1
                
                # Quick data quality checks (warnings only)
                name = row.get('Name', '').strip()
                if name and '\\' in name:
                    print(f"⚠️ Row {i}: Name contains backslash: {name[:50]}")
                    warnings_count += 1
                if name and name.isdigit() and len(name) > 3:
                    print(f"⚠️ Row {i}: Name is just numbers: {name}")
                    warnings_count += 1
                if name and (name.endswith('\\') or name.endswith('\\\\')):
                    print(f"⚠️ Row {i}: Name ends with backslash: {name[:50]}")
                    warnings_count += 1
                    
            if bad == 0:
                if warnings_count > 0:
                    print(f"✅ OK (with {warnings_count} warning(s))")
                else:
                    print("✅ OK")
                return True
            else:
                print(f"⚠️ {bad} error(s) found")
                return False
    except FileNotFoundError:
        print(f"❌ File not found: {path}")
        return False
    except Exception as e:
        print(f"❌ Error: {e}")
        return False


# CLI ARGUMENT PARSING

def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="Validate CSV files for WatchDNA Store Locator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exit Codes:
  0 - Validation passed
  1 - Usage/argument error
  2 - Schema/header errors
  3 - Data validation errors
  4 - Unexpected exception/IO error

Examples:
  Single file validation:
    %(prog)s locations.csv
    %(prog)s data/locations_2025-10-06.csv --json
    %(prog)s locations.csv --fail-duplicates --show-bad
    %(prog)s locations.csv --required Name,Latitude,Longitude --limit 100
  
  Batch validation (validate all CSVs in a directory):
    %(prog)s --batch
    %(prog)s --batch --directory output
    %(prog)s --batch --directory scraped_data --fail-duplicates
        """
    )

    parser.add_argument(
        "file",
        nargs='?',
        help="Path to CSV file to validate (optional if using --batch)"
    )

    parser.add_argument(
        "--required",
        default=",".join(DEFAULT_REQUIRED),
        help=f"Comma-separated list of required columns (default: {','.join(DEFAULT_REQUIRED)})"
    )

    parser.add_argument(
        "--warn-duplicates",
        action="store_true",
        default=True,
        help="Report duplicates as warnings (default: true)"
    )

    parser.add_argument(
        "--no-warn-duplicates",
        action="store_false",
        dest="warn_duplicates",
        help="Disable duplicate warnings"
    )

    parser.add_argument(
        "--fail-duplicates",
        action="store_true",
        default=False,
        help="Treat duplicates as errors (default: false)"
    )

    parser.add_argument(
        "--show-bad",
        action="store_true",
        default=False,
        help="Print full row content for rows with errors"
    )

    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only check first N data rows"
    )

    parser.add_argument(
        "--max-rows",
        type=int,
        default=MAX_ROWS_WARNING,
        help=f"Warn if file exceeds this many rows (default: {MAX_ROWS_WARNING})"
    )

    parser.add_argument(
        "--json",
        action="store_true",
        default=False,
        help="Output JSON format in addition to console text"
    )

    parser.add_argument(
        "--db-import-parity",
        action="store_true",
        default=False,
        help="Match backend DB import rules: require Phone; at least one of Address Line 1 or 2 (overrides --required)",
    )

    parser.add_argument(
        "--simple",
        action="store_true",
        default=False,
        help="Use simple validation (same as module import)"
    )

    parser.add_argument(
        "--batch",
        action="store_true",
        default=False,
        help="Validate all CSV files in a directory"
    )

    parser.add_argument(
        "--directory",
        default="output",
        help="Directory to scan for CSV files when using --batch (default: output)"
    )

    parser.add_argument(
        "--remove-duplicates",
        action="store_true",
        default=False,
        help="Remove duplicate rows from the CSV file (keeps first occurrence)"
    )

    parser.add_argument(
        "--fix",
        dest="auto_fix",
        action="store_true",
        default=False,
        help="Automatically fix data quality issues (backslashes, control characters, etc.)"
    )

    parser.add_argument(
        "--check-urls",
        dest="check_urls",
        action="store_true",
        default=False,
        help="Validate URLs by making HTTP requests (slower but more thorough)"
    )

    return parser.parse_args()


def batch_validate(directory: str, args):
    """
    Validate all CSV files in a directory
    
    Args:
        directory: Directory path to scan for CSV files
        args: Parsed command line arguments
    
    Returns:
        Exit code (0 if all pass, 3 if any fail)
    """
    from pathlib import Path
    
    dir_path = Path(directory)
    
    if not dir_path.exists():
        print(f"❌ Directory not found: {directory}")
        return EXIT_USAGE
    
    # Find all CSV files
    csv_files = list(dir_path.glob("*.csv"))
    
    if not csv_files:
        print(f"⚠️  No CSV files found in {directory}")
        return EXIT_OK
    
    print("=" * 70)
    print(f"BATCH CSV VALIDATION - {len(csv_files)} file(s) in {directory}")
    print("=" * 70)
    print()
    
    results = []
    total_errors = 0
    total_warnings = 0
    total_rows = 0
    
    # Parse required headers once (--db-import-parity overrides --required)
    if getattr(args, "db_import_parity", False):
        required_headers = list(DEFAULT_REQUIRED_DB_IMPORT)
    else:
        required_headers = [h.strip() for h in args.required.split(",") if h.strip()]

    for csv_file in sorted(csv_files):
        print(f"📄 {csv_file.name}")
        print("-" * 70)
        
        # Create validator
        validator = CSVValidator(
            required_headers=required_headers,
            warn_duplicates=args.warn_duplicates,
            fail_duplicates=args.fail_duplicates,
            show_bad=False,  # Don't show full rows in batch mode
            limit=args.limit,
            max_rows=args.max_rows,
            check_urls=args.check_urls,
            db_import_parity=bool(getattr(args, "db_import_parity", False)),
        )

        # Validate
        exit_code = validator.validate_file(str(csv_file))
        
        # Store results
        error_count = len(validator.errors)
        warning_count = len(validator.warnings)
        total_errors += error_count
        total_warnings += warning_count
        total_rows += validator.rows_checked
        
        status = "✅ PASS" if error_count == 0 else "❌ FAIL"
        results.append({
            "file": csv_file.name,
            "status": status,
            "rows": validator.rows_checked,
            "errors": error_count,
            "warnings": warning_count
        })
        
        # Print brief summary for this file
        if error_count > 0:
            print(f"❌ {error_count} error(s):")
            for error in validator.errors[:3]:  # Show first 3 errors
                print(f"   • {error}")
            if error_count > 3:
                print(f"   ... and {error_count - 3} more")
        else:
            print(f"✅ OK ({validator.rows_checked} rows)")
        
        if warning_count > 0:
            print(f"⚠️  {warning_count} warning(s)")
        
        print()
    
    # Print summary table
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"{'File':<35} {'Status':<8} {'Rows':<8} {'Errors':<8} {'Warnings':<8}")
    print("-" * 70)
    
    for result in results:
        print(f"{result['file']:<35} {result['status']:<8} {result['rows']:<8} "
              f"{result['errors']:<8} {result['warnings']:<8}")
    
    print("-" * 70)
    print(f"{'TOTAL':<35} {'':<8} {total_rows:<8} {total_errors:<8} {total_warnings:<8}")
    print("=" * 70)
    
    # Exit with appropriate code
    if total_errors > 0:
        print(f"\n❌ Validation failed: {total_errors} total error(s) across {len(csv_files)} file(s)")
        return EXIT_DATA
    else:
        print(f"\n✅ All files validated successfully! ({total_rows} total rows)")
        if total_warnings > 0:
            print(f"⚠️  {total_warnings} total warning(s) - review recommended")
        return EXIT_OK


def main():
    """Main entry point"""
    args = parse_args()

    # Handle batch mode
    if args.batch:
        exit_code = batch_validate(args.directory, args)
        sys.exit(exit_code)

    # Require file argument if not in batch mode
    if not args.file:
        print("❌ Error: file argument required (or use --batch to validate a directory)")
        print("Run with -h for help")
        sys.exit(EXIT_USAGE)

    # If --simple flag, use simple validation
    if args.simple:
        valid = validate_csv(args.file)
        sys.exit(0 if valid else 2)

    # Parse required headers (--db-import-parity overrides --required)
    if args.db_import_parity:
        required_headers = list(DEFAULT_REQUIRED_DB_IMPORT)
    else:
        required_headers = [h.strip() for h in args.required.split(",") if h.strip()]

    # Create validator
    validator = CSVValidator(
        required_headers=required_headers,
        warn_duplicates=args.warn_duplicates,
        fail_duplicates=args.fail_duplicates,
        show_bad=args.show_bad,
        limit=args.limit,
        max_rows=args.max_rows,
        check_urls=args.check_urls,
        db_import_parity=args.db_import_parity,
    )

    # Validate file (with auto-fix if requested)
    exit_code = validator.validate_file(args.file, auto_fix=args.auto_fix)

    # If schema errors, exit early
    if exit_code == EXIT_SCHEMA or exit_code == EXIT_EXCEPTION:
        sys.exit(exit_code)

    # Remove duplicates if requested
    if args.remove_duplicates:
        print()
        print("🔧 Removing duplicates...")
        duplicates_removed = validator.remove_duplicates_from_file(args.file)
        
        if duplicates_removed > 0:
            print(f"✅ Removed {duplicates_removed} duplicate row(s)")
            print(f"💾 Updated file: {args.file}")
            print()
            
            # Re-validate to show clean results
            print("🔍 Re-validating cleaned file...")
            print()
            validator = CSVValidator(
                required_headers=required_headers,
                warn_duplicates=args.warn_duplicates,
                fail_duplicates=args.fail_duplicates,
                show_bad=args.show_bad,
                limit=args.limit,
                max_rows=args.max_rows,
                check_urls=args.check_urls,
                db_import_parity=args.db_import_parity,
            )
            exit_code = validator.validate_file(args.file)
        else:
            print("✅ No duplicates found")
            print()

    # Print report
    validator.print_report()

    # Output JSON if requested
    if args.json:
        json_report = validator.get_json_report()
        print()
        print("JSON OUTPUT:")
        print(json.dumps(json_report, indent=2))

    # Determine final exit code
    if validator.errors:
        sys.exit(EXIT_DATA)
    else:
        sys.exit(EXIT_OK)


if __name__ == "__main__":
    main()
