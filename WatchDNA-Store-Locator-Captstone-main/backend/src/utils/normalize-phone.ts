/**
 * Phone number normalization to E.164 format.
 * Uses libphonenumber-js with the store's country as a regional hint.
 * Falls back to the trimmed original string if parsing fails.
 */

import { parsePhoneNumber, isValidPhoneNumber, type CountryCode } from 'libphonenumber-js';
import * as isoCountries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json';

isoCountries.registerLocale(enLocale);

/** Resolve a country display name (e.g. "United States") to an ISO alpha-2 code (e.g. "US"). */
function countryToRegionCode(country: string | null | undefined): CountryCode | undefined {
  if (!country) return undefined;
  const trimmed = country.trim();
  if (!trimmed) return undefined;

  // Direct alpha-2 lookup
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    return trimmed.toUpperCase() as CountryCode;
  }

  const code = isoCountries.getAlpha2Code(trimmed, 'en');
  return code ? (code as CountryCode) : undefined;
}

/**
 * Normalize a raw phone string to E.164 format using the country as a regional hint.
 * Returns the E.164 string on success, or the trimmed original if parsing fails.
 * Returns null for empty/null input.
 */
export function normalizePhone(
  phone: string | null | undefined,
  country: string | null | undefined
): string | null {
  const raw = (phone ?? '').trim();
  if (!raw) return null;

  const regionCode = countryToRegionCode(country);

  try {
    const parsed = parsePhoneNumber(raw, regionCode);
    if (parsed && isValidPhoneNumber(raw, regionCode)) {
      return parsed.format('E.164');
    }
  } catch {
    // fall through to return original
  }

  // If we have a region code and the number didn't parse, try without region
  // (the number may already have a country code prefix)
  if (regionCode) {
    try {
      const parsed = parsePhoneNumber(raw);
      if (parsed && parsed.isValid()) {
        return parsed.format('E.164');
      }
    } catch {
      // fall through
    }
  }

  return raw;
}
