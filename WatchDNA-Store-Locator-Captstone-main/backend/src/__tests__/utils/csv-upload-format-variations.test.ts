/**
 * CSV upload format-variation tests.
 *
 * Simulates the realistic "messy third-party CSV" scenarios an admin might upload.
 * Each test exercises the same normalization/parsing steps the live pipeline runs:
 *
 *   preNormalizeCsvFile (country + phone + handle generation)
 *   → parseRowToLocationData (field mapping, brand normalization)
 *   → isRowCompleteForDb (gate before DB write)
 *   → normalizeBrandsCsvField (alias resolution, dedupe)
 *
 * No actual DB or file-system writes — all assertions are on pure transform outputs.
 */

import { describe, expect, it } from 'vitest';
import { parseRowToLocationData, normalizedCountryAndPhoneFromCsvRow } from '../../utils/csv-to-location';
import { isRowCompleteForDb } from '../../utils/row-completeness';
import { normalizeScraperRowsForCsv } from '../../utils/stable-handle';
import { normalizeBrandsCsvField, brandConfigIdToDisplayName } from '../../utils/brand-display-name';
import { normalizeCountry } from '../../utils/country';
import { normalizePhone } from '../../utils/normalize-phone';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Minimal valid row — all required fields present. */
function baseRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Handle: 'src-handle-001',
    Name: 'Test Boutique',
    Status: 'active',
    'Address Line 1': '10 Rue de la Paix',
    'Address Line 2': '',
    City: 'Paris',
    'State/Province/Region': '',
    Country: 'France',
    'Postal/ZIP Code': '75001',
    Phone: '+33 1 42 00 00 00',
    Email: '',
    Website: '',
    Latitude: '48.86901',
    Longitude: '2.33100',
    Brands: 'OMEGA',
    Tags: '',
    ...overrides,
  };
}

// ─── 1. Handle generation ────────────────────────────────────────────────────

describe('Missing or blank Handle', () => {
  it('generates a deterministic loc_* handle when Handle is omitted', () => {
    const row = baseRow({ Handle: '' });
    const parsed = parseRowToLocationData(row);
    expect(parsed).not.toBeNull();
    expect(parsed!.handle).toMatch(/^loc_[a-f0-9]{24}$/);
  });

  it('produces the same handle on repeated calls (deterministic)', () => {
    const row = baseRow({ Handle: '' });
    const a = parseRowToLocationData(row);
    const b = parseRowToLocationData(row);
    expect(a!.handle).toBe(b!.handle);
  });

  it('preserves a provided upstream handle (does not overwrite)', () => {
    const row = baseRow({ Handle: 'brand-supplied-id-789' });
    const parsed = parseRowToLocationData(row);
    expect(parsed!.handle).toBe('brand-supplied-id-789');
  });

  it('normalizeScraperRowsForCsv assigns stable handle to complete rows', () => {
    const rows = [baseRow({ Handle: '' })];
    const [out] = normalizeScraperRowsForCsv(rows);
    expect(out.Handle).toMatch(/^loc_[a-f0-9]{24}$/);
  });

  it('normalizeScraperRowsForCsv keeps original handle for incomplete rows', () => {
    const rows = [baseRow({ Handle: 'keep-me', 'Address Line 1': '', 'Address Line 2': '' })];
    const [out] = normalizeScraperRowsForCsv(rows);
    expect(out.Handle).toBe('keep-me');
  });
});

// ─── 2. Country normalization ────────────────────────────────────────────────

describe('Country field variants', () => {
  const cases: [string, string][] = [
    ['US', 'United States'],
    ['us', 'United States'],
    ['USA', 'United States'],
    ['United States of America', 'United States'],
    ['united states', 'United States'],
    ['UNITED STATES', 'United States'],
    ['UK', 'United Kingdom'],
    ['GB', 'United Kingdom'],
    ['England', 'United Kingdom'],
    ['UAE', 'United Arab Emirates'],
    ['AE', 'United Arab Emirates'],
    ['Hong Kong SAR', 'Hong Kong'],
    ['Hong Kong SAR, China', 'Hong Kong'],
    ['HK', 'Hong Kong'],
    ['Korea', 'South Korea'],
    ['KR', 'South Korea'],
    ['Czechia', 'Czech Republic'],
    ['CZ', 'Czech Republic'],
    ['Suisse', 'Switzerland'],
    ['CH', 'Switzerland'],
    ['france', 'France'],
    ['FRANCE', 'France'],
    ['FR', 'France'],
    ['DE', 'Germany'],
    ['JP', 'Japan'],
    ['Macau SAR', 'Macau'],
    ['Macao', 'Macau'],
    ["People's Republic of China", 'China'],
    ['PRC', 'China'],
    ['Turkiye', 'Turkey'],
    ['The Netherlands', 'Netherlands'],
    ['untied states', 'United States'],
  ];

  it.each(cases)('normalizeCountry(%s) → %s', (raw, expected) => {
    expect(normalizeCountry(raw)).toBe(expected);
  });

  it('country normalization flows through parseRowToLocationData', () => {
    const parsed = parseRowToLocationData(baseRow({ Country: 'US' }));
    expect(parsed!.country).toBe('United States');
  });

  it('country normalization flows through normalizeScraperRowsForCsv', () => {
    const [out] = normalizeScraperRowsForCsv([baseRow({ Country: 'GB' })]);
    expect(out.Country).toBe('United Kingdom');
  });
});

// ─── 3. Phone normalization ──────────────────────────────────────────────────

describe('Phone field variants', () => {
  it('formats US national number with country hint to E.164', () => {
    expect(normalizePhone('(212) 555-0100', 'United States')).toBe('+12125550100');
  });

  it('formats US number written with dashes to E.164', () => {
    expect(normalizePhone('212-555-0100', 'United States')).toBe('+12125550100');
  });

  it('keeps already-correct E.164 number unchanged', () => {
    expect(normalizePhone('+12125550100', 'United States')).toBe('+12125550100');
  });

  it('formats French national number with country hint', () => {
    // 01 42 86 87 88 is valid Paris number
    const result = normalizePhone('01 42 86 87 88', 'France');
    expect(result).toMatch(/^\+33/);
  });

  it('returns null for empty phone', () => {
    expect(normalizePhone('', 'United States')).toBeNull();
    expect(normalizePhone(null, 'United States')).toBeNull();
  });

  it('phone flows through normalizedCountryAndPhoneFromCsvRow with ISO country', () => {
    const { country, phone } = normalizedCountryAndPhoneFromCsvRow({
      Country: 'US',
      Phone: '(212) 555-0100',
    });
    expect(country).toBe('United States');
    expect(phone).toBe('+12125550100');
  });
});

// ─── 4. Brand field variants ─────────────────────────────────────────────────

describe('Brand field variants', () => {
  it('normalizes brand config ID (omega_stores) to display name', () => {
    expect(brandConfigIdToDisplayName('omega_stores')).toBe('OMEGA');
  });

  it('normalizes scraper key with underscores (bell_ross_stores)', () => {
    expect(brandConfigIdToDisplayName('bell_ross_stores')).toBe('BELL & ROSS');
  });

  it('normalizes tagheuer alias', () => {
    expect(brandConfigIdToDisplayName('tagheuer_stores')).toBe('TAG HEUER');
    expect(brandConfigIdToDisplayName('TAG-HEUER')).toBe('TAG HEUER');
  });

  it('deduplicates case-insensitive brand tokens', () => {
    const result = normalizeBrandsCsvField('OMEGA, omega, omega_stores');
    expect(result).toBe('OMEGA');
  });

  it('handles comma-separated multiple brands', () => {
    const result = normalizeBrandsCsvField('ROLEX, OMEGA');
    expect(result).toContain('ROLEX');
    expect(result).toContain('OMEGA');
  });

  it('passes through completely unknown brand name unchanged', () => {
    const result = normalizeBrandsCsvField('MY BRAND NEW WATCH CO');
    expect(result).toBe('MY BRAND NEW WATCH CO');
  });

  it('strips HTML-contaminated brand tokens', () => {
    const result = normalizeBrandsCsvField('<a href="/x">OMEGA</a>');
    expect(result).toBe('OMEGA');
  });

  it('rejects tokens that look like address lines (88 Rue du Rhone)', () => {
    const result = normalizeBrandsCsvField('88 RUE DU RHONE');
    expect(result).toBeNull();
  });

  it('returns null for empty Brands column', () => {
    expect(normalizeBrandsCsvField('')).toBeNull();
    expect(normalizeBrandsCsvField(null)).toBeNull();
  });

  it('flows through parseRowToLocationData — brand ID resolved to display', () => {
    const parsed = parseRowToLocationData(baseRow({ Brands: 'omega_stores' }));
    expect(parsed!.brands).toBe('OMEGA');
  });

  it('flows through parseRowToLocationData — unknown brand stored as-is', () => {
    const parsed = parseRowToLocationData(baseRow({ Brands: 'UNKNOWN BOUTIQUE BRAND' }));
    expect(parsed!.brands).toBe('UNKNOWN BOUTIQUE BRAND');
  });
});

// ─── 5. Status field variants ────────────────────────────────────────────────

describe('Status field variants', () => {
  const trueValues = ['active', 'true', 'TRUE', 'True', '1', 'yes', 'YES', ''];
  const falseValues = ['false', 'FALSE', 'False', 'inactive', 'no', 'NO', '0'];

  it.each(trueValues)('Status="%s" parses as true', (val) => {
    const parsed = parseRowToLocationData(baseRow({ Status: val }));
    expect(parsed!.status).toBe(true);
  });

  it.each(falseValues)('Status="%s" parses as false', (val) => {
    const parsed = parseRowToLocationData(baseRow({ Status: val }));
    expect(parsed!.status).toBe(false);
  });
});

// ─── 6. Completeness gate ────────────────────────────────────────────────────

describe('Row completeness gate (isRowCompleteForDb)', () => {
  it('accepts a row with all required fields', () => {
    expect(isRowCompleteForDb(baseRow())).toBe(true);
  });

  it('accepts when only Address Line 2 is filled (Line 1 empty)', () => {
    const row = baseRow({ 'Address Line 1': '', 'Address Line 2': 'PO Box 42' });
    expect(isRowCompleteForDb(row)).toBe(true);
  });

  it('accepts row without Phone (phone is optional)', () => {
    expect(isRowCompleteForDb(baseRow({ Phone: '' }))).toBe(true);
  });

  it('rejects when Name is blank', () => {
    expect(isRowCompleteForDb(baseRow({ Name: '' }))).toBe(false);
  });

  it('rejects when both address lines are blank', () => {
    const row = baseRow({ 'Address Line 1': '', 'Address Line 2': '' });
    expect(isRowCompleteForDb(row)).toBe(false);
  });

  it('rejects when Latitude is missing', () => {
    expect(isRowCompleteForDb(baseRow({ Latitude: '' }))).toBe(false);
  });

  it('rejects when Longitude is non-numeric', () => {
    expect(isRowCompleteForDb(baseRow({ Longitude: 'unknown' }))).toBe(false);
  });
});

// ─── 7. parseRowToLocationData rejects incomplete rows ───────────────────────

describe('parseRowToLocationData rejects rows that cannot be written to DB', () => {
  it('returns null when Name is missing', () => {
    expect(parseRowToLocationData(baseRow({ Name: '' }))).toBeNull();
  });

  it('returns null when Latitude is absent', () => {
    expect(parseRowToLocationData(baseRow({ Latitude: '' }))).toBeNull();
  });

  it('returns null when Longitude is NaN', () => {
    expect(parseRowToLocationData(baseRow({ Longitude: 'n/a' }))).toBeNull();
  });
});

// ─── 8. Extra / unknown columns ──────────────────────────────────────────────

describe('Extra columns in CSV', () => {
  it('parses correctly when unknown extra columns are present', () => {
    const rowWithExtras = {
      ...baseRow(),
      'Internal ID': 'abc-123',
      'Region Manager': 'John',
      'Custom Field': 'some value',
    };
    const parsed = parseRowToLocationData(rowWithExtras);
    expect(parsed).not.toBeNull();
    expect(parsed!.name).toBe('Test Boutique');
  });
});

// ─── 9. Whitespace / trimming ────────────────────────────────────────────────

describe('Whitespace in field values', () => {
  it('trims leading/trailing whitespace from Name', () => {
    const parsed = parseRowToLocationData(baseRow({ Name: '  Test Boutique  ' }));
    expect(parsed!.name).toBe('Test Boutique');
  });

  it('trims whitespace from Handle', () => {
    const parsed = parseRowToLocationData(baseRow({ Handle: '  my-handle  ' }));
    expect(parsed!.handle).toBe('my-handle');
  });

  it('trims and normalizes City via country pipeline', () => {
    const { country } = normalizedCountryAndPhoneFromCsvRow({
      Country: '  France  ',
      Phone: '',
    });
    expect(country).toBe('France');
  });
});

// ─── 10. Mixed batch: complete and incomplete rows ───────────────────────────

describe('Batch with mixed complete / incomplete rows', () => {
  const goodRow = baseRow({ Handle: '', Name: 'Good Store', 'Address Line 1': '1 Good St' });
  const noName = baseRow({ Handle: '', Name: '', 'Address Line 1': '2 No-Name St' });
  const noCoords = baseRow({ Handle: '', Name: 'No Coords', Latitude: '', Longitude: '' });
  const noAddress = baseRow({ Handle: '', 'Address Line 1': '', 'Address Line 2': '' });

  it('normalizeScraperRowsForCsv assigns handle to the good row, skips others', () => {
    const normalized = normalizeScraperRowsForCsv([goodRow, noName, noCoords, noAddress]);
    const handles = normalized.map((r) => r.Handle);
    // Good row gets a stable loc_* handle
    expect(handles[0]).toMatch(/^loc_[a-f0-9]{24}$/);
    // Incomplete rows keep whatever handle they had (empty string in this case)
    expect(handles[1]).toBe('');
    expect(handles[2]).toBe('');
    expect(handles[3]).toBe('');
  });

  it('isRowCompleteForDb filters out incomplete rows before DB write', () => {
    const rows = [goodRow, noName, noCoords, noAddress];
    const complete = rows.filter(isRowCompleteForDb);
    expect(complete).toHaveLength(1);
    expect(complete[0]!.Name).toBe('Good Store');
  });

  it('parseRowToLocationData returns null for each incomplete row', () => {
    expect(parseRowToLocationData(noName)).toBeNull();
    expect(parseRowToLocationData(noCoords)).toBeNull();
    // noAddress passes parseRowToLocation because it has Name + coords — address gate is in isRowCompleteForDb
    const noAddrParsed = parseRowToLocationData(noAddress);
    // Row has no address but all other fields — isRowCompleteForDb will reject it before upsert
    expect(isRowCompleteForDb(noAddress)).toBe(false);
    // parseRowToLocationData itself only gates on Name + coords (not address — that's the completeness check)
    expect(noAddrParsed).not.toBeNull(); // parse succeeds but completeness gate will reject
  });
});

// ─── 11. sourceStoreKey / BrandStoreId dedup field ──────────────────────────

describe('Brand-supplied store keys (BrandStoreId / SourceStoreKey)', () => {
  it('reads BrandStoreId into sourceStoreKey', () => {
    const parsed = parseRowToLocationData({ ...baseRow(), BrandStoreId: 'brand-999' });
    expect(parsed!.sourceStoreKey).toBe('brand-999');
  });

  it('reads SourceStoreKey into sourceStoreKey', () => {
    const parsed = parseRowToLocationData({ ...baseRow(), SourceStoreKey: 'src-key-42' });
    expect(parsed!.sourceStoreKey).toBe('src-key-42');
  });

  it('returns null sourceStoreKey when neither field present', () => {
    const parsed = parseRowToLocationData(baseRow());
    expect(parsed!.sourceStoreKey).toBeNull();
  });
});

// ─── 12. State dedup (city = state → drop state) ────────────────────────────

describe('State/Province redundancy dedup', () => {
  it('drops State when it is identical to City (e.g. UAE emirates)', () => {
    const parsed = parseRowToLocationData(
      baseRow({ City: 'Dubai', 'State/Province/Region': 'Dubai', Country: 'UAE' })
    );
    expect(parsed!.stateProvinceRegion).toBeNull();
  });

  it('keeps State when it differs from City', () => {
    const parsed = parseRowToLocationData(
      baseRow({ City: 'Austin', 'State/Province/Region': 'Texas', Country: 'United States' })
    );
    expect(parsed!.stateProvinceRegion).toBe('Texas');
  });
});
