/**
 * Converts a raw CSV row (parsed with papaparse header:true) into a Prisma-ready
 * Location data object. Returns null if required fields are missing or invalid.
 *
 * The CSV uses human-readable column headers (e.g. "Address Line 1").
 * Prisma model fields use camelCase (e.g. addressLine1).
 */
import { normalizeCountry } from './country';
import { normalizePhone } from './normalize-phone';
import { normalizeBrandsCsvField, normalizeTagsCsvField } from './brand-display-name';
import crypto from 'crypto';

/**
 * Single source of truth for Country + Phone on master-CSV-shaped rows (DB import, scraper job CSV, job editor).
 * Normalizes country first; phone uses that as the regional hint (same as libphonenumber-js path in normalize-phone).
 */
export function normalizedCountryAndPhoneFromCsvRow(row: Record<string, any>): {
  country: string;
  phone: string | null;
} {
  const country = normalizeCountry(String(row.Country ?? ''));
  const phone = normalizePhone(row.Phone, country || undefined);
  return { country, phone };
}

/**
 * When upstream data repeats the locality in City and State/Province (common for UAE emirates, etc.),
 * drop the redundant state so we do not store or export "Dubai" twice.
 */
export function dedupeStateWhenSameAsCity(
  cityRaw: string | null | undefined,
  stateRaw: string | null | undefined
): string | null {
  const city = String(cityRaw ?? '').trim();
  const st = String(stateRaw ?? '').trim();
  if (!st) return null;
  if (city && st.toLowerCase() === city.toLowerCase()) return null;
  return st;
}

export interface LocationData {
  handle: string;
  /**
   * Optional brand-supplied store identifier (column: "BrandStoreId" or "SourceStoreKey").
   * When two rows in the same batch share the same non-empty key they are treated as the
   * same store and collapsed before triplet deduplication, even if name/address/geo differ.
   */
  sourceStoreKey?: string | null;
  name: string;
  status: boolean;
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string | null;
  city: string;
  stateProvinceRegion: string | null;
  country: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  imageUrl: string | null;
  monday: string | null;
  tuesday: string | null;
  wednesday: string | null;
  thursday: string | null;
  friday: string | null;
  saturday: string | null;
  sunday: string | null;
  latitude: number;
  longitude: number;
  pageTitle: string | null;
  pageDescription: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  priority: number | null;
  tags: string | null;
  brands: string | null;
  customBrands: string | null;
  isPremium: boolean;
  nameFr: string | null;
  pageTitleFr: string | null;
  pageDescriptionFr: string | null;
  customBrandsFr: string | null;
  nameZhCn: string | null;
  pageTitleZhCn: string | null;
  pageDescriptionZhCn: string | null;
  customBrandsZhCn: string | null;
  nameEs: string | null;
  pageTitleEs: string | null;
  pageDescriptionEs: string | null;
  customBrandsEs: string | null;
  customButton1Title: string | null;
  customButton1Url: string | null;
  customButton1TitleFr: string | null;
  customButton1UrlFr: string | null;
  customButton1TitleZhCn: string | null;
  customButton1UrlZhCn: string | null;
  customButton1TitleEs: string | null;
  customButton1UrlEs: string | null;
  customButton2Title: string | null;
  customButton2Url: string | null;
  customButton2TitleFr: string | null;
  customButton2UrlFr: string | null;
  customButton2TitleZhCn: string | null;
  customButton2UrlZhCn: string | null;
  customButton2TitleEs: string | null;
  customButton2UrlEs: string | null;
}

/**
 * Parses a raw Status cell to a boolean.
 * Treats "active", "true", "yes", and "1" as active; everything else (including
 * an empty/absent value) defaults to true so that stores without an explicit
 * status are imported as active rather than silently hidden.
 */
function parseStatusField(raw: string | undefined | null): boolean {
  if (!raw || !raw.trim()) return true;
  const v = raw.trim().toLowerCase();
  if (v === 'false' || v === 'inactive' || v === 'no' || v === '0') return false;
  return true;
}

/**
 * Deterministic handle fallback used when CSV rows omit Handle.
 * Matches stable-handle rules so imports still dedupe/upsert correctly.
 */
function computeFallbackHandleFromCsvRow(
  row: Record<string, any>,
  country: string,
  latitude: number,
  longitude: number
): string {
  const norm = (v: unknown): string =>
    String(v ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const addr1 = norm(row['Address Line 1']);
  const addr2 = norm(row['Address Line 2']);
  const city = norm(row.City);
  const key = [
    addr1 || addr2 || '',
    city,
    normalizeCountry(country).toLowerCase(),
    latitude.toFixed(5),
    longitude.toFixed(5),
  ].join('|');
  const digest = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 24);
  return `loc_${digest}`;
}

/**
 * Parse a CSV row into a LocationData object suitable for Prisma upsert.
 * Returns null if Name or coordinates are missing/invalid.
 * Handle falls back to a deterministic loc_* value when omitted.
 */
export function parseRowToLocationData(row: Record<string, any>): LocationData | null {
  const latitude = parseFloat(row.Latitude);
  const longitude = parseFloat(row.Longitude);

  if (!row.Name || isNaN(latitude) || isNaN(longitude)) {
    return null;
  }

  const { country, phone } = normalizedCountryAndPhoneFromCsvRow(row);
  const rawHandle = String(row.Handle ?? '').trim();
  const handle = rawHandle || computeFallbackHandleFromCsvRow(row, country, latitude, longitude);

  const rawKey = row['BrandStoreId'] || row['SourceStoreKey'] || null;

  return {
    handle,
    sourceStoreKey: rawKey ? String(rawKey).trim() : null,
    name: String(row.Name).trim(),
    status: parseStatusField(row.Status),
    addressLine1: row['Address Line 1'] || '',
    addressLine2: row['Address Line 2'] || null,
    postalCode: row['Postal/ZIP Code'] || null,
    city: row.City || '',
    stateProvinceRegion: dedupeStateWhenSameAsCity(row.City, row['State/Province/Region']),
    country,
    phone,
    email: row.Email || null,
    website: row.Website || null,
    imageUrl: row['Image URL'] || null,
    monday: row.Monday || null,
    tuesday: row.Tuesday || null,
    wednesday: row.Wednesday || null,
    thursday: row.Thursday || null,
    friday: row.Friday || null,
    saturday: row.Saturday || null,
    sunday: row.Sunday || null,
    latitude,
    longitude,
    pageTitle: row['Page Title'] || null,
    pageDescription: row['Page Description'] || null,
    metaTitle: row['Meta Title'] || null,
    metaDescription: row['Meta Description'] || null,
    priority: row.Priority ? parseInt(row.Priority) : null,
    // Support both " Tags" (legacy leading space) and "Tags"
    tags: normalizeTagsCsvField(row[' Tags'] || row.Tags || null),
    brands: normalizeBrandsCsvField(row.Brands || null),
    customBrands: row['Custom Brands'] || null,
    isPremium: false,
    nameFr: row['Name - FR'] || null,
    pageTitleFr: row['Page Title - FR'] || null,
    pageDescriptionFr: row['Page Description - FR'] || null,
    customBrandsFr: row['Custom Brands - FR'] || null,
    nameZhCn: row['Name - ZH-CN'] || null,
    pageTitleZhCn: row['Page Title - ZH-CN'] || null,
    pageDescriptionZhCn: row['Page Description - ZH-CN'] || null,
    customBrandsZhCn: row['Custom Brands - ZH-CN'] || null,
    nameEs: row['Name - ES'] || null,
    pageTitleEs: row['Page Title - ES'] || null,
    pageDescriptionEs: row['Page Description - ES'] || null,
    customBrandsEs: row['Custom Brands - ES'] || null,
    customButton1Title: row['Custom Button title 1'] || null,
    customButton1Url: row['Custom Button URL 1'] || null,
    customButton1TitleFr: row['Custom Button title 1 - FR'] || null,
    customButton1UrlFr: row['Custom Button URL 1 - FR'] || null,
    customButton1TitleZhCn: row['Custom Button title 1 - ZH-CN'] || null,
    customButton1UrlZhCn: row['Custom Button URL 1 - ZH-CN'] || null,
    customButton1TitleEs: row['Custom Button title 1 - ES'] || null,
    customButton1UrlEs: row['Custom Button URL 1 - ES'] || null,
    customButton2Title: row['Custom Button title 2'] || null,
    customButton2Url: row['Custom Button URL 2'] || null,
    customButton2TitleFr: row['Custom Button title 2 - FR'] || null,
    customButton2UrlFr: row['Custom Button URL 2 - FR'] || null,
    customButton2TitleZhCn: row['Custom Button title 2 - ZH-CN'] || null,
    customButton2UrlZhCn: row['Custom Button URL 2 - ZH-CN'] || null,
    customButton2TitleEs: row['Custom Button title 2 - ES'] || null,
    customButton2UrlEs: row['Custom Button URL 2 - ES'] || null,
  };
}

/**
 * Map a Prisma Location record back to a CSV-column-keyed plain object.
 * Used when returning DB records in the same shape the frontend expects from CSV reads.
 */
export function locationToCSVRow(loc: Record<string, any>): Record<string, string> {
  return {
    Handle: loc.handle ?? '',
    Name: loc.name ?? '',
    Status: loc.status ? 'true' : 'false',
    'Address Line 1': loc.addressLine1 ?? '',
    'Address Line 2': loc.addressLine2 ?? '',
    'Postal/ZIP Code': loc.postalCode ?? '',
    City: loc.city ?? '',
    'State/Province/Region': loc.stateProvinceRegion ?? '',
    Country: loc.country ?? '',
    Phone: loc.phone ?? '',
    Email: loc.email ?? '',
    Website: loc.website ?? '',
    'Image URL': loc.imageUrl ?? '',
    Monday: loc.monday ?? '',
    Tuesday: loc.tuesday ?? '',
    Wednesday: loc.wednesday ?? '',
    Thursday: loc.thursday ?? '',
    Friday: loc.friday ?? '',
    Saturday: loc.saturday ?? '',
    Sunday: loc.sunday ?? '',
    Latitude: loc.latitude != null ? String(loc.latitude) : '',
    Longitude: loc.longitude != null ? String(loc.longitude) : '',
    'Page Title': loc.pageTitle ?? '',
    'Page Description': loc.pageDescription ?? '',
    'Meta Title': loc.metaTitle ?? '',
    'Meta Description': loc.metaDescription ?? '',
    Priority: loc.priority != null ? String(loc.priority) : '',
    Tags: loc.tags ?? '',
    Brands: loc.brands ?? '',
    'Custom Brands': loc.customBrands ?? '',
    'Name - FR': loc.nameFr ?? '',
    'Page Title - FR': loc.pageTitleFr ?? '',
    'Page Description - FR': loc.pageDescriptionFr ?? '',
    'Custom Brands - FR': loc.customBrandsFr ?? '',
    'Name - ZH-CN': loc.nameZhCn ?? '',
    'Page Title - ZH-CN': loc.pageTitleZhCn ?? '',
    'Page Description - ZH-CN': loc.pageDescriptionZhCn ?? '',
    'Custom Brands - ZH-CN': loc.customBrandsZhCn ?? '',
    'Name - ES': loc.nameEs ?? '',
    'Page Title - ES': loc.pageTitleEs ?? '',
    'Page Description - ES': loc.pageDescriptionEs ?? '',
    'Custom Brands - ES': loc.customBrandsEs ?? '',
    'Custom Button title 1': loc.customButton1Title ?? '',
    'Custom Button URL 1': loc.customButton1Url ?? '',
    'Custom Button title 1 - FR': loc.customButton1TitleFr ?? '',
    'Custom Button URL 1 - FR': loc.customButton1UrlFr ?? '',
    'Custom Button title 1 - ZH-CN': loc.customButton1TitleZhCn ?? '',
    'Custom Button URL 1 - ZH-CN': loc.customButton1UrlZhCn ?? '',
    'Custom Button title 1 - ES': loc.customButton1TitleEs ?? '',
    'Custom Button URL 1 - ES': loc.customButton1UrlEs ?? '',
    'Custom Button title 2': loc.customButton2Title ?? '',
    'Custom Button URL 2': loc.customButton2Url ?? '',
    'Custom Button title 2 - FR': loc.customButton2TitleFr ?? '',
    'Custom Button URL 2 - FR': loc.customButton2UrlFr ?? '',
    'Custom Button title 2 - ZH-CN': loc.customButton2TitleZhCn ?? '',
    'Custom Button URL 2 - ZH-CN': loc.customButton2UrlZhCn ?? '',
    'Custom Button title 2 - ES': loc.customButton2TitleEs ?? '',
    'Custom Button URL 2 - ES': loc.customButton2UrlEs ?? '',
  };
}
