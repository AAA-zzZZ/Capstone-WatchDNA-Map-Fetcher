#!/usr/bin/env python3
"""Test scraping for configured brands (Rolex, Omega, etc.)."""

import argparse
import json
import os
import sys
import time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from universal_scraper import universal_scrape


def load_brand_configs():
    config_path = os.path.join(os.path.dirname(__file__), 'brand_configs.json')
    with open(config_path, 'r') as f:
        configs = json.load(f)
    return configs


def test_brand(brand_id: str, brand_config: dict, quick_mode: bool = False, validate: bool = True):
    print("\n" + "=" * 80)
    print(f"🧪 Testing: {brand_id.upper()}")
    print("=" * 80)
    print(f"Type: {brand_config.get('type', 'unknown')}")
    print(f"URL: {brand_config.get('url', 'N/A')}")
    print(f"Description: {brand_config.get('description', 'N/A')}")
    print("-" * 80)
    
    test_output_dir = os.path.join(os.path.dirname(__file__), 'test_output')
    os.makedirs(test_output_dir, exist_ok=True)
    
    timestamp = int(time.time())
    output_file = os.path.join(test_output_dir, f"{brand_id}_test_{timestamp}.csv")
    
    region = 'north_america' if quick_mode else 'world'
    
    try:
        start_time = time.time()
        
        results = universal_scrape(
            url=brand_config['url'],
            output_file=output_file,
            region=region,
            force_type=None,  # Auto-detect
            validate_output=validate,
            brand_config=brand_config
        )
        
        elapsed_time = time.time() - start_time
        
        print("\n" + "-" * 80)
        if results.get('success'):
            print("✅ SUCCESS")
            print(f"   Detected Type: {results.get('detected_type', 'unknown')}")
            print(f"   Expansion Used: {'Yes' if results.get('expansion_used') else 'No'}")
            print(f"   Stores Found: {results.get('stores_found', 0):,}")
            print(f"   Stores Normalized: {results.get('stores_normalized', 0):,}")
            print(f"   Output File: {output_file}")
            print(f"   Time Taken: {elapsed_time:.2f}s")
            
            if os.path.exists(output_file):
                file_size = os.path.getsize(output_file)
                print(f"   File Size: {file_size:,} bytes ({file_size / 1024:.2f} KB)")
                
                with open(output_file, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                    data_rows = len(lines) - 1 if len(lines) > 1 else 0
                    print(f"   CSV Rows: {data_rows:,} (plus header)")
                
                if validate and results.get('validation_performed'):
                    validation_passed = results.get('validation_passed', False)
                    if validation_passed:
                        print(f"   ✅ CSV validation passed")
                    else:
                        validation_error = results.get('validation_error', '')
                        if validation_error:
                            print(f"   ⚠️  Validation issues: {validation_error}")
                        else:
                            print(f"   ⚠️  Validation found issues (check output above)")
            
            return {
                'success': True,
                'brand_id': brand_id,
                'stores_found': results.get('stores_found', 0),
                'stores_normalized': results.get('stores_normalized', 0),
                'output_file': output_file,
                'elapsed_time': elapsed_time
            }
        else:
            print("❌ FAILED")
            print(f"   Error: {results.get('error', 'Unknown error')}")
            return {
                'success': False,
                'brand_id': brand_id,
                'error': results.get('error', 'Unknown error')
            }
            
    except Exception as e:
        print(f"\n❌ ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        return {
            'success': False,
            'brand_id': brand_id,
            'error': str(e)
        }


def main():
    parser = argparse.ArgumentParser(
        description='Test scraping capabilities for configured brands',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3 test_scraping.py                    # Test all enabled brands
  python3 test_scraping.py --brand rolex      # Test only Rolex
  python3 test_scraping.py --brand omega      # Test only Omega
  python3 test_scraping.py --quick            # Quick test (limited region)
        """
    )
    
    parser.add_argument('--brand', help='Test specific brand (e.g., rolex_retailers, omega_stores)')
    parser.add_argument('--quick', action='store_true', help='Quick test mode (uses smaller region)')
    parser.add_argument('--no-validate', action='store_true', help='Skip CSV validation (faster but less thorough)')
    parser.add_argument('--list', action='store_true', help='List all available brands and exit')
    
    args = parser.parse_args()
    
    configs = load_brand_configs()
    brands = {k: v for k, v in configs.items() if k != '_README' and v.get('enabled', True) != False}
    if args.list:
        print("Available Brands:")
        print("-" * 80)
        for brand_id, config in brands.items():
            print(f"  {brand_id:30s} | {config.get('type', 'unknown'):10s} | {config.get('description', 'N/A')}")
        return 0
    if args.brand:
        if args.brand not in brands:
            print(f"❌ Error: Brand '{args.brand}' not found")
            print(f"Available brands: {', '.join(brands.keys())}")
            return 1
        brands_to_test = {args.brand: brands[args.brand]}
    else:
        brands_to_test = brands
    print("\n" + "=" * 80)
    print("🧪 STORE SCRAPING TEST SUITE")
    print("=" * 80)
    print(f"Testing {len(brands_to_test)} brand(s)")
    if args.quick:
        print("⚡ Quick mode enabled (limited region)")
    if args.no_validate:
        print("⚠️  Validation disabled (using normalizer only)")
    else:
        print("✅ Using normalizer + validator")
    print(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    results = []
    validate = not args.no_validate
    for brand_id, brand_config in brands_to_test.items():
        result = test_brand(brand_id, brand_config, quick_mode=args.quick, validate=validate)
        results.append(result)
        time.sleep(1)
    print("\n" + "=" * 80)
    print("📊 TEST SUMMARY")
    print("=" * 80)
    
    successful = [r for r in results if r['success']]
    failed = [r for r in results if not r['success']]
    
    print(f"\n✅ Successful: {len(successful)}/{len(results)}")
    for r in successful:
        print(f"   • {r['brand_id']:30s} | {r['stores_normalized']:>6,} stores | {r['elapsed_time']:>6.2f}s")
    
    if failed:
        print(f"\n❌ Failed: {len(failed)}/{len(results)}")
        for r in failed:
            print(f"   • {r['brand_id']:30s} | {r.get('error', 'Unknown error')}")
    
    print("\n" + "=" * 80)
    return 0 if len(failed) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())

