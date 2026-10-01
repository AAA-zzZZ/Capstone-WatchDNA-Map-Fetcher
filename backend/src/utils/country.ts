/**
 * Country name normalization for the backend.
 *
 * Mirrors the logic in Prototypes/Data_Scrappers/country_normalize.py so that
 * country values are handled consistently whether they enter via a fresh CSV
 * import or via an API query parameter.
 *
 * Resolution order:
 *   1. Aliases (e.g. "USA", "UK", "UAE") → canonical full name
 *   2. 2-letter ISO alpha-2 code → watch_store_countries.json first, then i18n-iso-countries
 *   3. Full-name string → case-insensitive match against JSON values
 *   4. Unrecognised → returned trimmed as-is
 */

import * as isoCountries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';

import watchCountriesData from '../data/watch_store_countries.json';

isoCountries.registerLocale(enLocale);

// Code → preferred full name (project-level overrides)
const JSON_CODES: Record<string, string> = watchCountriesData.countries as Record<string, string>;
// Lowercase full name → canonical casing
const JSON_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(JSON_CODES).map((name) => [name.toLowerCase(), name])
);

const ALIASES: Record<string, string> = {
  // United States
  'usa': 'United States',
  'u.s.': 'United States',
  'u.s.a.': 'United States',
  'united states of america': 'United States',
  // United Kingdom
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'britain': 'United Kingdom',
  'england': 'United Kingdom',
  'scotland': 'United Kingdom',
  'wales': 'United Kingdom',
  'northern ireland': 'United Kingdom',
  // United Arab Emirates
  'uae': 'United Arab Emirates',
  'u.a.e.': 'United Arab Emirates',
  // South Korea
  'korea': 'South Korea',
  'republic of korea': 'South Korea',
  // Czech Republic
  'czechia': 'Czech Republic',
  // Hong Kong (SAR / postal / map variants that scrapers emit as separate strings)
  'hk': 'Hong Kong',
  'hong kong sar': 'Hong Kong',
  'hong kong sar, china': 'Hong Kong',
  'hong kong sar. china': 'Hong Kong',
  'hong kong, china': 'Hong Kong',
  'hong kong sar china': 'Hong Kong',
  // Macau / Macao SAR variants
  'macao': 'Macau',
  'macau sar': 'Macau',
  'macau sar, china': 'Macau',
  'macau sar. china': 'Macau',
  'macao sar': 'Macau',
  'macao sar, china': 'Macau',
  'macao sar. china': 'Macau',
  // China (long-form English names vs short "China")
  "people's republic of china": 'China',
  'peoples republic of china': 'China',
  "the people's republic of china": 'China',
  'prc': 'China',
  'mainland china': 'China',
  // Taiwan
  'taiwan, province of china': 'Taiwan',
  'taiwan province of china': 'Taiwan',
  'taiwan, china': 'Taiwan',
  'chinese taipei': 'Taiwan',
  // Russia
  'russian federation': 'Russia',
  // Iran
  'iran, islamic republic of': 'Iran',
  // Syria
  'syrian arab republic': 'Syria',
  // Vietnam
  'viet nam': 'Vietnam',
  // South Africa
  'rsa': 'South Africa',
  // United States of America (returned by i18n-iso-countries for US)
  'brasil': 'Brazil',
  // French/alternate spelling of Belgium
  'belgique': 'Belgium',
  // Brunei Darussalam (ISO official long name → project canonical)
  'brunei darussalam': 'Brunei',
  // Scrapers / suppliers (not matched by i18n English name)
  'kingdom of saudi arabia': 'Saudi Arabia',
  'macedonia': 'North Macedonia',
  'suisse': 'Switzerland',
  'taiwan region': 'Taiwan',
  'taiwan region. china': 'Taiwan',
  'taiwan region, china': 'Taiwan',
  'united states virgin islands': 'Virgin Islands, U.S.',
  'u.s. virgin islands': 'Virgin Islands, U.S.',
  'saint-barthelemy': 'Saint Barthélemy',
  'saint martin': 'Saint Martin (French part)',
  'caribbean netherlands': 'Bonaire, Sint Eustatius and Saba',
  // ISO official name variants with articles / parentheticals
  'bahamas (the)': 'Bahamas',
  'bahamas, the': 'Bahamas',
  // Countries not in watch_store_countries.json — need explicit alias for case normalization
  'dominican republic': 'Dominican Republic',
  // Accent/encoding variants
  'curacao': 'Curaçao',
  // Comma-separated country qualifiers from scraper sources
  'macau, china': 'Macau',
  // Alternative names / parenthetical suffixes
  'myanmar (burma)': 'Myanmar',
  'burma': 'Myanmar',
  // Misspellings from scraper / user data
  'saudia arabia': 'Saudi Arabia',
  'untied states': 'United States',
  // Turkish name variants (Turkey is canonical in watch_store_countries.json)
  'turkiye': 'Turkey',
  'türkiye': 'Turkey',
  // "The" prefix variants
  'the netherlands': 'Netherlands',
};

/**
 * Return the canonical English country name for a raw country value.
 * Empty / whitespace input returns an empty string.
 */
export function normalizeCountry(value: string): string {
  if (!value) return '';
  const stripped = value.trim();
  if (!stripped) return '';

  const lower = stripped.toLowerCase();

  // 1. Alias check
  const alias = ALIASES[lower];
  if (alias) return alias;

  // 2. ISO alpha-2 code (exactly 2 letters)
  if (/^[A-Za-z]{2}$/.test(stripped)) {
    const code = stripped.toUpperCase();

    // JSON first
    const jsonResult = JSON_CODES[code];
    if (jsonResult) return jsonResult;

    // i18n-iso-countries fallback
    const isoName = isoCountries.getName(code, 'en');
    if (isoName) {
      // Check if i18n name itself needs alias resolution
      const isoAlias = ALIASES[isoName.toLowerCase()];
      return isoAlias ?? isoName;
    }

    // Unknown alpha-2 — return as-is
    return stripped;
  }

  // 3. Full-name → canonical casing from JSON
  const jsonCanon = JSON_NAMES[lower];
  if (jsonCanon) return jsonCanon;

  // 4. No match — return trimmed original
  return stripped;
}

/** Preferred English names from project JSON (subset of ISO world; used as a fallback for i18n spelling gaps). */
const CANONICAL_COUNTRY_NAMES = new Set(Object.values(JSON_CODES));

/**
 * True if the value normalizes to a jurisdiction treated as ISO 3166-1 (country or territory), e.g. Hong Kong, Puerto Rico.
 * False for typical mistakes such as putting a city in the country column ("Paris", "London").
 *
 * Note: Hong Kong is ISO 3166-1 alpha-2 HK; using Country = Hong Kong and City = district (e.g. Central) is normal.
 */
export function isRecognizedCountryOrTerritory(value: string): boolean {
  const n = normalizeCountry(value).trim();
  if (!n) return false;

  if (/^[A-Za-z]{2}$/.test(n)) {
    const code = n.toUpperCase();
    if (JSON_CODES[code]) return true;
    return Boolean(isoCountries.getName(code, 'en'));
  }

  if (isoCountries.getAlpha2Code(n, 'en')) return true;

  // i18n English uses "Macao" (MO); we normalize scraper data to "Macau"
  if (n.toLowerCase() === 'macau') {
    return Boolean(isoCountries.getName('MO', 'en'));
  }

  if (CANONICAL_COUNTRY_NAMES.has(n)) return true;

  return false;
}
