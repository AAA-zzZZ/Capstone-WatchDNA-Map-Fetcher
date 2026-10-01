import { describe, it, expect } from 'vitest';
import {
  addressesShareStreetNumber,
  buildDedupPlans,
  buildManualMergePlan,
  buildMergePlanFromGroup,
  GEO_PROXIMITY_M,
  MAX_GROUP_SPREAD_M,
  mergePremiumNotesParts,
  sortSurvivorFirst,
  type MergeStoreRow,
} from '../../utils/location-merge-core';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const BASE_DATE = new Date('2024-01-01T00:00:00Z');
const LATER_DATE = new Date('2024-06-01T00:00:00Z');

function row(overrides: Partial<MergeStoreRow> = {}): MergeStoreRow {
  return {
    handle: 'loc_test',
    name: 'Test Store',
    brands: null,
    customBrands: null,
    tags: null,
    addressLine1: '123 Main Street',
    city: 'Toronto',
    country: 'Canada',
    latitude: 43.6532,
    longitude: -79.3832,
    isPremium: false,
    updatedAt: BASE_DATE,
    ...overrides,
  };
}

// ─── addressesShareStreetNumber ───────────────────────────────────────────────

describe('addressesShareStreetNumber', () => {
  it('returns true when both share a number', () => {
    expect(addressesShareStreetNumber('100 King St', '100 King Street')).toBe(true);
  });

  it('returns false when numbers differ', () => {
    expect(addressesShareStreetNumber('1600 Water St', '5001 Expressway')).toBe(false);
  });

  it('returns true when one address has no multi-digit number', () => {
    expect(addressesShareStreetNumber('King Street', '1600 King Street')).toBe(true);
  });

  it('returns true when both have no multi-digit numbers', () => {
    expect(addressesShareStreetNumber('Main St', 'Main Street')).toBe(true);
  });

  it('ignores single-digit numbers', () => {
    // "5 King" vs "9 Queen" — single digits excluded, so treated as no-number → true
    expect(addressesShareStreetNumber('5 King St', '9 Queen Ave')).toBe(true);
  });
});

// ─── sortSurvivorFirst ────────────────────────────────────────────────────────

describe('sortSurvivorFirst', () => {
  it('puts premium first', () => {
    const a = row({ handle: 'a', isPremium: false });
    const b = row({ handle: 'b', isPremium: true });
    expect(sortSurvivorFirst(a, b)).toBeGreaterThan(0);
    expect(sortSurvivorFirst(b, a)).toBeLessThan(0);
  });

  it('prefers more brands when premium is equal', () => {
    const a = row({ handle: 'a', brands: 'BrandA' });
    const b = row({ handle: 'b', brands: 'BrandA,BrandB' });
    expect(sortSurvivorFirst(a, b)).toBeGreaterThan(0);
  });

  it('prefers longer name as tiebreaker', () => {
    const a = row({ handle: 'a', name: 'Store' });
    const b = row({ handle: 'b', name: 'Store International' });
    expect(sortSurvivorFirst(a, b)).toBeGreaterThan(0);
  });

  it('prefers more recently updated as tiebreaker', () => {
    const a = row({ handle: 'a', updatedAt: BASE_DATE });
    const b = row({ handle: 'b', updatedAt: LATER_DATE });
    expect(sortSurvivorFirst(a, b)).toBeGreaterThan(0);
  });

  it('falls back to handle lexicographic order', () => {
    const a = row({ handle: 'aaa' });
    const b = row({ handle: 'bbb' });
    expect(sortSurvivorFirst(a, b)).toBeLessThan(0);
  });
});

// ─── buildMergePlanFromGroup ──────────────────────────────────────────────────

describe('buildMergePlanFromGroup', () => {
  it('selects premium survivor over non-premium', () => {
    const a = row({ handle: 'a', isPremium: false });
    const b = row({ handle: 'b', isPremium: true, brands: 'BrandB' });
    const plan = buildMergePlanFromGroup([a, b], 'address-fingerprint');
    expect(plan.keep.handle).toBe('b');
    expect(plan.remove).toHaveLength(1);
    expect(plan.remove[0]!.handle).toBe('a');
  });

  it('unions brands from all members', () => {
    const a = row({ handle: 'a', brands: 'BrandA' });
    const b = row({ handle: 'b', brands: 'BrandB' });
    const plan = buildMergePlanFromGroup([a, b], 'geo-proximity');
    // normalizeBrandsCsvField uppercases brand names
    expect(plan.mergedBrands).toContain('BRANDA');
    expect(plan.mergedBrands).toContain('BRANDB');
  });

  it('keeps the longest name', () => {
    const a = row({ handle: 'a', name: 'Store', updatedAt: LATER_DATE });
    const b = row({ handle: 'b', name: 'Store International' });
    const plan = buildMergePlanFromGroup([a, b], 'address-fingerprint');
    expect(plan.mergedName).toBe('Store International');
  });

  it('preserves the label', () => {
    const a = row({ handle: 'a' });
    const b = row({ handle: 'b' });
    expect(buildMergePlanFromGroup([a, b], 'address-fingerprint').label).toBe('address-fingerprint');
    expect(buildMergePlanFromGroup([a, b], 'geo-proximity').label).toBe('geo-proximity');
  });
});

// ─── buildManualMergePlan ─────────────────────────────────────────────────────

describe('buildManualMergePlan', () => {
  it('uses the given survivor as keep regardless of premium heuristics', () => {
    const survivor = row({ handle: 'low', isPremium: false, brands: 'A' });
    const other = row({ handle: 'high', isPremium: true, brands: 'B' });
    const plan = buildManualMergePlan(survivor, [other]);
    expect(plan.keep.handle).toBe('low');
    expect(plan.remove.map((r) => r.handle)).toEqual(['high']);
    expect(plan.label).toBe('manual');
  });

  it('unions brands like buildMergePlanFromGroup', () => {
    const survivor = row({ handle: 's', brands: 'BrandA' });
    const o1 = row({ handle: 'o1', brands: 'BrandB' });
    const o2 = row({ handle: 'o2', customBrands: 'CustomX' });
    const plan = buildManualMergePlan(survivor, [o1, o2]);
    expect(plan.mergedBrands).toContain('BRANDA');
    expect(plan.mergedBrands).toContain('BRANDB');
    expect(plan.mergedCustomBrands).toBeTruthy();
  });

  it('sorts remove handles lexicographically', () => {
    const survivor = row({ handle: 'z' });
    const a = row({ handle: 'm' });
    const b = row({ handle: 'a' });
    const plan = buildManualMergePlan(survivor, [a, b]);
    expect(plan.remove.map((r) => r.handle)).toEqual(['a', 'm']);
  });
});

// ─── buildDedupPlans ──────────────────────────────────────────────────────────

describe('buildDedupPlans', () => {
  it('returns empty for a single store', () => {
    expect(buildDedupPlans([row()])).toHaveLength(0);
  });

  it('groups two rows with identical address fingerprint in the same city', () => {
    const a = row({ handle: 'a', addressLine1: '100 King Street' });
    const b = row({ handle: 'b', addressLine1: '100 King St' }); // same fingerprint: 100kingstreet
    const plans = buildDedupPlans([a, b]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.label).toBe('address-fingerprint');
  });

  it('does NOT group rows with the same address fingerprint but in different cities', () => {
    const a = row({ handle: 'a', addressLine1: '100 King Street', city: 'Toronto' });
    const b = row({ handle: 'b', addressLine1: '100 King St', city: 'Vancouver' });
    expect(buildDedupPlans([a, b])).toHaveLength(0);
  });

  it('groups nearby rows with similar names via geo-proximity', () => {
    // Same lat/lon, same name, different address string (different fingerprint)
    const a = row({ handle: 'a', addressLine1: '100 King Street' });
    const b = row({
      handle: 'b',
      addressLine1: '100 Roi Street', // different fp; "Roi" is French for "King" — treated as different
      latitude: 43.6532 + 0.0005, // ~55 m north — within GEO_PROXIMITY_M
      longitude: -79.3832,
    });
    const plans = buildDedupPlans([a, b]);
    // Both share "100" street number, same country, similar names, ≤150 m → geo-proximity merge
    expect(plans).toHaveLength(1);
    expect(plans[0]!.label).toBe('geo-proximity');
  });

  it('does NOT group nearby rows with different names (different stores, same block)', () => {
    // Genuinely different address fingerprints + completely different names — the geo-proximity
    // pass should block this pair because namesSimilarForDedupe returns false.
    const a = row({ handle: 'a', name: 'Tim Hortons', addressLine1: '100 Main Street' });
    const b = row({
      handle: 'b',
      name: 'Starbucks Coffee',
      addressLine1: '104 Broadway Avenue',
      latitude: 43.6532 + 0.0003, // ~33 m north — within GEO_PROXIMITY_M
      longitude: -79.3832,
    });
    expect(buildDedupPlans([a, b])).toHaveLength(0);
  });

  it('skips address-fingerprint group whose coordinate spread exceeds MAX_GROUP_SPREAD_M', () => {
    const a = row({ handle: 'a', addressLine1: '100 King Street', latitude: 43.0, longitude: -79.0 });
    const b = row({ handle: 'b', addressLine1: '100 King St', latitude: 50.0, longitude: -79.0 });
    // ~780 km apart — clearly different cities sharing a street name
    expect(buildDedupPlans([a, b])).toHaveLength(0);
  });

  it('still groups address-fingerprint pair when one member has an unusable coordinate', () => {
    const a = row({ handle: 'a', addressLine1: '100 King Street', latitude: 0, longitude: 0 }); // usable check: (0,0) is treated as unusable
    const b = row({ handle: 'b', addressLine1: '100 King St' });
    const plans = buildDedupPlans([a, b]);
    // Only one usable coord → spread check skipped → should merge
    expect(plans).toHaveLength(1);
  });

  it('keeps different-named boutiques at the same address separate (Omega vs IWC)', () => {
    const a = row({ handle: 'a', name: 'Omega Boutique', addressLine1: 'Allée François Blanc' });
    const b = row({ handle: 'b', name: 'IWC Boutique', addressLine1: 'Allée François Blanc' });
    expect(buildDedupPlans([a, b])).toHaveLength(0);
  });

  it('still merges name variants at the same address, split from a distinct boutique', () => {
    const a = row({ handle: 'a', name: 'Omega Boutique', addressLine1: 'Allée François Blanc' });
    const b = row({ handle: 'b', name: 'OMEGA Boutique Monte-Carlo', addressLine1: 'Allee Francois Blanc' });
    const c = row({ handle: 'c', name: 'IWC Boutique', addressLine1: 'Allée François Blanc' });
    const plans = buildDedupPlans([a, b, c]);
    expect(plans).toHaveLength(1);
    const merged = [plans[0]!.keep.handle, ...plans[0]!.remove.map((r) => r.handle)].sort();
    expect(merged).toEqual(['a', 'b']);
  });

  it('never auto-merges two premium-program stores, even with similar names at one address', () => {
    const a = row({ handle: 'a', name: 'LA MAISON MONACO | BOUTIQUE ROYALMOUNT', addressLine1: '5050 Côte-de-Liesse', isPremium: true });
    const b = row({ handle: 'b', name: 'LA MAISON MONACO | TAG HEUER BOUTIQUE ROYALMOUNT', addressLine1: '5050 Cote-de-Liesse', isPremium: true });
    expect(buildDedupPlans([a, b])).toHaveLength(0);
    // A non-premium duplicate may still fold into a premium record.
    const c = row({ handle: 'c', name: 'La Maison Monaco Boutique Royalmount', addressLine1: '5050 Côte-de-Liesse', isPremium: false });
    const plans = buildDedupPlans([a, c]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.keep.handle).toBe('a');
  });

  it('deduplicates handles across fp pass 1 and geo pass 2', () => {
    const a = row({ handle: 'a', addressLine1: '100 King Street' });
    const b = row({ handle: 'b', addressLine1: '100 King St' }); // same fp as a
    const c = row({
      handle: 'c',
      addressLine1: '100 King Blvd',
      latitude: 43.6532 + 0.0003,
      longitude: -79.3832,
    }); // different fp, nearby
    const plans = buildDedupPlans([a, b, c]);
    // a+b captured in pass 1; c is a new geo candidate not re-grouped with the pass-1 group
    const allHandles = plans.flatMap((p) => [p.keep.handle, ...p.remove.map((r) => r.handle)]);
    const unique = new Set(allHandles);
    expect(unique.size).toBe(allHandles.length); // no handle appears twice
  });
});

// ─── mergePremiumNotesParts ───────────────────────────────────────────────────

describe('mergePremiumNotesParts', () => {
  it('returns undefined for all empty/null inputs', () => {
    expect(mergePremiumNotesParts(null, undefined, '')).toBeUndefined();
  });

  it('returns single non-empty note as-is', () => {
    expect(mergePremiumNotesParts('note one')).toBe('note one');
  });

  it('joins multiple notes with separator', () => {
    const result = mergePremiumNotesParts('note A', 'note B');
    expect(result).toContain('note A');
    expect(result).toContain('note B');
    expect(result).toContain('merged from duplicate');
  });

  it('skips empty strings', () => {
    const result = mergePremiumNotesParts('', 'note C', null);
    expect(result).toBe('note C');
  });
});
