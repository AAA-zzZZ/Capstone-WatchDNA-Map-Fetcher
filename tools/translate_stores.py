#!/usr/bin/env python3
"""
Batch-translate non-Latin store names/addresses to English.

Reads DATABASE_URL from backend/.env, finds Location rows with non-Latin
characters in name/addressLine1/city where the corresponding *En column is
NULL, translates via Google Translate (free, through deep-translator), and
writes the result back.  Idempotent: already-translated rows are skipped.

Usage:
    python3 tools/translate_stores.py          # live run
    python3 tools/translate_stores.py --dry    # preview, no DB writes
"""

import re
import sys
import time
import argparse
from pathlib import Path

import psycopg2
from deep_translator import GoogleTranslator

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
NON_LATIN_RE = re.compile(r'[^\x00-\x7F\xC0-\xFF]')  # anything outside Latin-1
BATCH_SIZE = 10        # translate N strings at once (Google allows ~5000 chars)
RATE_DELAY = 1.5       # seconds between batches to avoid rate-limits

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_database_url() -> str:
    """Read DATABASE_URL from backend/.env"""
    env_path = Path(__file__).resolve().parent.parent / 'backend' / '.env'
    if not env_path.exists():
        sys.exit(f"ERROR: {env_path} not found")
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line.startswith('DATABASE_URL='):
            val = line.split('=', 1)[1].strip().strip('"').strip("'")
            return val
    sys.exit("ERROR: DATABASE_URL not found in backend/.env")


def has_non_latin(text: str) -> bool:
    return bool(NON_LATIN_RE.search(text or ''))


def translate_batch(texts: list[str], src: str = 'auto', dest: str = 'en') -> list[str]:
    """Translate a list of strings. Returns list of translated strings."""
    translator = GoogleTranslator(source=src, target=dest)
    results = []
    for text in texts:
        if not text or not text.strip():
            results.append(text)
            continue
        for attempt in range(3):
            try:
                translated = translator.translate(text)
                results.append(translated if translated else text)
                time.sleep(0.3)  # small delay between individual translations
                break
            except Exception as e:
                if attempt < 2 and 'too many requests' in str(e).lower():
                    wait = 5 * (attempt + 1)
                    print(f"  Rate limited, waiting {wait}s...")
                    time.sleep(wait)
                else:
                    print(f"  WARN: translation failed for '{text[:40]}': {e}")
                    results.append(text)
                    break
    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Translate non-Latin store fields to English")
    parser.add_argument('--dry', action='store_true', help="Preview only, no DB writes")
    args = parser.parse_args()

    db_url = load_database_url()
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor()

    # Find rows with non-Latin chars (outside ASCII + Latin-1 range) that
    # haven't been translated yet.  The regex matches CJK, Hangul, Cyrillic,
    # Arabic, Thai, Devanagari and other non-Latin scripts.
    cur.execute(r"""
        SELECT id, name, "addressLine1", city
        FROM "Location"
        WHERE (
            "nameEn" IS NULL OR "addressLine1En" IS NULL OR "cityEn" IS NULL
        )
        AND (
            name ~ '[^\x00-\x7F\xC0-\xFF]'
            OR "addressLine1" ~ '[^\x00-\x7F\xC0-\xFF]'
            OR city ~ '[^\x00-\x7F\xC0-\xFF]'
        )
        ORDER BY id
    """)
    to_translate = cur.fetchall()

    print(f"Found {len(to_translate)} stores with non-Latin text needing translation")
    if not to_translate:
        print("Nothing to do.")
        cur.close()
        conn.close()
        return

    translated_count = 0
    failed_count = 0

    for i in range(0, len(to_translate), BATCH_SIZE):
        batch = to_translate[i:i + BATCH_SIZE]
        print(f"\nBatch {i // BATCH_SIZE + 1} ({len(batch)} stores)...")

        # Collect all strings to translate in this batch
        names_to_translate = []
        addrs_to_translate = []
        cities_to_translate = []

        for row_id, name, addr, city in batch:
            names_to_translate.append(name if has_non_latin(name or '') else None)
            addrs_to_translate.append(addr if has_non_latin(addr or '') else None)
            cities_to_translate.append(city if has_non_latin(city or '') else None)

        # Translate non-None entries
        all_texts = []
        index_map = []  # (batch_idx, field) for each entry in all_texts
        for idx, (n, a, c) in enumerate(zip(names_to_translate, addrs_to_translate, cities_to_translate)):
            if n:
                index_map.append((idx, 'name'))
                all_texts.append(n)
            if a:
                index_map.append((idx, 'addr'))
                all_texts.append(a)
            if c:
                index_map.append((idx, 'city'))
                all_texts.append(c)

        if not all_texts:
            continue

        translated_texts = translate_batch(all_texts)

        # Map translations back
        translated_names = [None] * len(batch)
        translated_addrs = [None] * len(batch)
        translated_cities = [None] * len(batch)

        for (idx, field), translated in zip(index_map, translated_texts):
            if field == 'name':
                translated_names[idx] = translated
            elif field == 'addr':
                translated_addrs[idx] = translated
            elif field == 'city':
                translated_cities[idx] = translated

        # Update DB
        for j, (row_id, name, addr, city) in enumerate(batch):
            name_en = translated_names[j]
            addr_en = translated_addrs[j]
            city_en = translated_cities[j]

            if args.dry:
                if name_en:
                    print(f"  {name[:40]} -> {name_en[:40]}")
                if addr_en:
                    print(f"  addr: {addr[:40]} -> {addr_en[:40]}")
                if city_en:
                    print(f"  city: {city[:30]} -> {city_en[:30]}")
                translated_count += 1
            else:
                try:
                    cur.execute("""
                        UPDATE "Location"
                        SET "nameEn" = COALESCE(%s, "nameEn"),
                            "addressLine1En" = COALESCE(%s, "addressLine1En"),
                            "cityEn" = COALESCE(%s, "cityEn")
                        WHERE id = %s
                    """, (name_en, addr_en, city_en, row_id))
                    translated_count += 1
                except Exception as e:
                    print(f"  ERROR updating {row_id}: {e}")
                    failed_count += 1

        if not args.dry:
            conn.commit()

        time.sleep(RATE_DELAY)

    if not args.dry:
        conn.commit()

    cur.close()
    conn.close()

    print(f"\nDone! Translated: {translated_count}, Failed: {failed_count}")
    if args.dry:
        print("(dry run — no changes written)")


if __name__ == '__main__':
    main()
