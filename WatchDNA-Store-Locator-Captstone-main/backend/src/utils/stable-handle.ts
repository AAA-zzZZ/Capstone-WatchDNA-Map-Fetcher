import crypto from 'crypto';
import { normalizeCountry } from './country';
import { normalizedCountryAndPhoneFromCsvRow } from './csv-to-location';
import { isRowCompleteForDb } from './row-completeness';

/** Lowercase, trim, collapse spaces — for handle hash address/city keys only. */
function normForStableHandleKey(s: string | undefined | null): string {
  const t = (s ?? '').trim().toLowerCase();
  const alnumSpaced = t.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return alnumSpaced;
}

/**
 * ASCII letters+digits only (matches PostgreSQL regexp_replace(..., '[^a-z0-9]', '', 'g') in dedupe SQL).
 */
export function addressFingerprintLine1(line1: string): string {
  return (line1 ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Deterministic handle from address + city + country + rounded coordinates.
 * Same physical store should map to the same handle across scraper runs even when
 * the upstream id in the CSV changes.
 */
export function computeStableHandleFromRow(row: Record<string, string>): string {
  return `loc_${crypto.createHash('sha256').update(stableHandleKey(row), 'utf8').digest('hex').slice(0, 24)}`;
}

/**
 * Handle variant that also hashes the normalized store name. Used only when two different
 * boutiques share one address + rounded coordinates (e.g. "Omega Boutique" and "IWC Boutique"
 * in the same building) and would otherwise collide on {@link computeStableHandleFromRow}.
 */
export function computeNameScopedHandleFromRow(row: Record<string, string>): string {
  const key = `${stableHandleKey(row)}|${normForStableHandleKey(row.Name)}`;
  return `loc_${crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24)}`;
}

function stableHandleKey(row: Record<string, string>): string {
  const lat = parseFloat(String(row.Latitude ?? ''));
  const lon = parseFloat(String(row.Longitude ?? ''));
  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    throw new Error('stable handle requires valid coordinates');
  }
  const addr1 = normForStableHandleKey(row['Address Line 1']);
  const addr2 = normForStableHandleKey(row['Address Line 2']);
  const addressPart = addr1 || addr2 || '';
  const city = normForStableHandleKey(row.City);
  const country = normalizeCountry(String(row.Country || '')).toLowerCase();
  return [addressPart, city, country, lat.toFixed(5), lon.toFixed(5)].join('|');
}

/**
 * Canonical Country + Phone on CSV-shaped rows via {@link normalizedCountryAndPhoneFromCsvRow}
 * (same code path as parseRowToLocationData / DB upsert).
 */
export function normalizeScraperFieldsForCsv(row: Record<string, string>): Record<string, string> {
  const { country, phone } = normalizedCountryAndPhoneFromCsvRow(row);
  const out = { ...row };
  if (Object.prototype.hasOwnProperty.call(row, 'Country')) {
    out.Country = country;
  }
  if (Object.prototype.hasOwnProperty.call(row, 'Phone')) {
    out.Phone = phone ?? '';
  }
  return out;
}

/**
 * For scraper job CSV + DB: normalize Country/Phone, then assign stable Handle when complete for DB.
 * Incomplete rows keep the source handle so editors can still see and fix them.
 */
export function normalizeScraperRowForCsv(row: Record<string, string>): Record<string, string> {
  const fields = normalizeScraperFieldsForCsv(row);
  if (!isRowCompleteForDb(fields)) return fields;
  try {
    return { ...fields, Handle: computeStableHandleFromRow(fields) };
  } catch {
    return fields;
  }
}

export function normalizeScraperRowsForCsv(rows: Record<string, string>[]): Record<string, string>[] {
  return rows.map(normalizeScraperRowForCsv);
}
