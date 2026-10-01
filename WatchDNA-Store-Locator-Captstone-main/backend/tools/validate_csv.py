#!/usr/bin/env python3
"""
Launcher for CSV Validator - delegates to canonical implementation in Data_Scrappers.
Used by backend validation.service.ts and imported by universal_scraper (via sys.path).
When imported: re-exports CSVValidator, DEFAULT_REQUIRED, validate_csv, etc.
When run as script: executes main() from canonical module.
"""
import sys
import os
import importlib.util

# Load canonical validator from Data_Scrappers (Prototypes is at repo root, not inside backend)
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(os.path.dirname(script_dir))  # backend/tools -> backend -> repo root
data_scrappers_dir = os.path.join(project_root, "Prototypes", "Data_Scrappers")
validator_path = os.path.join(data_scrappers_dir, "validate_csv.py")

# Ensure Data_Scrappers is on path so validate_csv can import scraper_utils, etc.
if data_scrappers_dir not in sys.path:
    sys.path.insert(0, data_scrappers_dir)

spec = importlib.util.spec_from_file_location("_validate_csv_canonical", validator_path)
validator_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator_module)

# Re-export for imports (universal_scraper does: from validate_csv import CSVValidator, DEFAULT_REQUIRED)
CSVValidator = validator_module.CSVValidator
DEFAULT_REQUIRED = validator_module.DEFAULT_REQUIRED
DEFAULT_REQUIRED_DB_IMPORT = validator_module.DEFAULT_REQUIRED_DB_IMPORT
validate_csv = validator_module.validate_csv
ValidationError = validator_module.ValidationError
ValidationWarning = validator_module.ValidationWarning
ALL_HEADERS = validator_module.ALL_HEADERS
REQUIRED = validator_module.REQUIRED
EXIT_OK = validator_module.EXIT_OK
EXIT_USAGE = validator_module.EXIT_USAGE
EXIT_SCHEMA = validator_module.EXIT_SCHEMA
EXIT_DATA = validator_module.EXIT_DATA
EXIT_EXCEPTION = validator_module.EXIT_EXCEPTION


def main():
    return validator_module.main()


if __name__ == "__main__":
    sys.exit(main())
