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

# Load canonical validator from Data_Scrappers
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
validator_path = os.path.join(project_root, "Prototypes", "Data_Scrappers", "validate_csv.py")
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
