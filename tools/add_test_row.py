import csv, sys
from pathlib import Path

def add_test_row(csv_path="locations.csv"):
    """Add a test row to CSV file"""
    path = Path(csv_path)
    if not path.exists():
        print(f"❌ {csv_path} not found")
        return False
    
    # Read the header exactly as-is
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        headers = next(reader)
    
    # Build a row with only the fields we care about; others stay blank
    row = {h: "" for h in headers}
    row.update({
        "Handle": "asu-test",
        "Name": "ASU Test Store",
        "Status": "TRUE",
        "Address Line 1": "1151 S Forest Ave",
        "Postal/ZIP Code": "85281",
        "City": "Tempe",
        "State/Province/Region": "Arizona",
        "Country": "USA",
        "Phone": "(480) 965-2100",
        "Latitude": "33.42131",
        "Longitude": "-111.93313",
        "Custom Brands": "TESTBRAND"
    })
    
    # Overwrite locations.csv with just the header + this one row
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        w.writerow(row)
    
    print("✅ Wrote 1 test row to locations.csv")
    return True

if __name__ == "__main__":
    csv_file = sys.argv[1] if len(sys.argv) > 1 else "locations.csv"
    add_test_row(csv_file)
