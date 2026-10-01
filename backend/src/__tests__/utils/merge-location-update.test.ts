import { describe, it, expect } from 'vitest';
import {
  mergeLocationDataForManualImport,
  mergeLocationDataForUpdate,
  stripCustomBrandsRedundantWithBrandsColumn,
  unifiedBrandsAfterMerge,
} from '../../utils/merge-location-update';
import type { LocationData } from '../../utils/csv-to-location';

function baseIncoming(overrides: Partial<LocationData> = {}): LocationData {
  return {
    handle: 'loc_x',
    name: 'Boutique',
    status: true,
    addressLine1: '1 Main',
    addressLine2: null,
    postalCode: null,
    city: 'NYC',
    stateProvinceRegion: null,
    country: 'United States',
    phone: '+1 212 555 0199',
    email: null,
    website: null,
    imageUrl: null,
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
    latitude: 40.7,
    longitude: -74.0,
    pageTitle: null,
    pageDescription: null,
    metaTitle: null,
    metaDescription: null,
    priority: null,
    tags: null,
    brands: 'OMEGA',
    customBrands: null,
    isPremium: false,
    nameFr: null,
    pageTitleFr: null,
    pageDescriptionFr: null,
    customBrandsFr: null,
    nameZhCn: null,
    pageTitleZhCn: null,
    pageDescriptionZhCn: null,
    customBrandsZhCn: null,
    nameEs: null,
    pageTitleEs: null,
    pageDescriptionEs: null,
    customBrandsEs: null,
    customButton1Title: null,
    customButton1Url: null,
    customButton1TitleFr: null,
    customButton1UrlFr: null,
    customButton1TitleZhCn: null,
    customButton1UrlZhCn: null,
    customButton1TitleEs: null,
    customButton1UrlEs: null,
    customButton2Title: null,
    customButton2Url: null,
    customButton2TitleFr: null,
    customButton2UrlFr: null,
    customButton2TitleZhCn: null,
    customButton2UrlZhCn: null,
    customButton2TitleEs: null,
    customButton2UrlEs: null,
    ...overrides,
  };
}

describe('mergeLocationDataForManualImport', () => {
  it('unions brands like scraper merge', () => {
    const existing = { brands: 'ROLEX', customBrands: null, phone: '+1 111' };
    const incoming = baseIncoming({ brands: 'OMEGA' });
    const out = mergeLocationDataForManualImport(existing, incoming);
    expect(out.brands).toContain('ROLEX');
    expect(out.brands).toContain('OMEGA');
  });

  it('uses CSV phone when non-empty', () => {
    const existing = { brands: null, customBrands: null, phone: '+1 000' };
    const incoming = baseIncoming({ phone: '+1 999' });
    expect(mergeLocationDataForManualImport(existing, incoming).phone).toBe('+1 999');
  });

  it('keeps DB phone when CSV phone is blank', () => {
    const existing = { brands: null, customBrands: null, phone: '+1 000' };
    const incoming = baseIncoming({ phone: '   ' });
    expect(mergeLocationDataForManualImport(existing, incoming).phone).toBe('+1 000');
  });

  it('differs from scraper merge which always keeps DB phone', () => {
    const existing = { brands: null, customBrands: null, phone: '+1 000' };
    const incoming = baseIncoming({ phone: '+1 999' });
    expect(mergeLocationDataForUpdate(existing, incoming).phone).toBe('+1 000');
    expect(mergeLocationDataForManualImport(existing, incoming).phone).toBe('+1 999');
  });
});

describe('mergeLocationDataForUpdate — cross-field brands (manual custom + scrape)', () => {
  it('folds manual custom-only brand into brands and drops redundant custom when scrape adds same brand', () => {
    const existing = { brands: null, customBrands: 'ROLEX', phone: '+1 000' };
    const incoming = baseIncoming({ brands: 'ROLEX', customBrands: null });
    const out = mergeLocationDataForUpdate(existing, incoming);
    expect(out.brands).toBe('ROLEX');
    expect(out.customBrands).toBeNull();
  });

  it('dedupes case-insensitive across brands and custom (single canonical label)', () => {
    const existing = { brands: 'rolex', customBrands: null, phone: '+1 000' };
    const incoming = baseIncoming({ brands: 'ROLEX', customBrands: null });
    const out = mergeLocationDataForUpdate(existing, incoming);
    expect(out.brands).toBe('ROLEX');
    expect(out.brands?.split(',').length).toBe(1);
  });

  it('pulls brand only in custom HTML into unified brands and clears redundant custom', () => {
    const existing = { brands: 'ROLEX', customBrands: '<a href="/x">TAG HEUER</a>', phone: '+1 000' };
    const incoming = baseIncoming({ brands: 'ROLEX', customBrands: null });
    const out = mergeLocationDataForUpdate(existing, incoming);
    expect(out.brands).toMatch(/ROLEX/);
    expect(out.brands).toMatch(/TAG HEUER/);
    expect(out.customBrands).toBeNull();
  });

  it('strips HTML custom when every anchor brand is already in brands', () => {
    const brands = unifiedBrandsAfterMerge('ROLEX', '<a href="/r">ROLEX</a>', 'ROLEX', null);
    expect(brands).toBe('ROLEX');
    const custom = stripCustomBrandsRedundantWithBrandsColumn('<a href="/r">ROLEX</a>', brands);
    expect(custom).toBeNull();
  });
});
