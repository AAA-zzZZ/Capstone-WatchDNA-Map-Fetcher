import type { Request } from 'express';
import { describe, it, expect } from 'vitest';

import {
  masterBrandPremiumScopeFromQuery,
  masterExportFiltersFromQuery,
} from '../../utils/parse-master-export-query';

function mockReq(query: Record<string, unknown>): Request {
  return { query } as Request;
}

describe('masterExportFiltersFromQuery', () => {
  it('returns undefined when no relevant params', () => {
    expect(masterExportFiltersFromQuery(mockReq({}))).toBeUndefined();
    expect(masterExportFiltersFromQuery(mockReq({ other: 'x' }))).toBeUndefined();
  });

  it('parses brand', () => {
    expect(masterExportFiltersFromQuery(mockReq({ brand: '  rolex_stores  ' }))).toEqual({
      brand: 'rolex_stores',
    });
  });

  it('parses country', () => {
    expect(masterExportFiltersFromQuery(mockReq({ country: 'CA' }))).toEqual({ country: 'CA' });
  });

  it('parses premium true variants', () => {
    expect(masterExportFiltersFromQuery(mockReq({ premium: 'true' }))).toEqual({ premiumOnly: true });
    expect(masterExportFiltersFromQuery(mockReq({ premium: '1' }))).toEqual({ premiumOnly: true });
    expect(masterExportFiltersFromQuery(mockReq({ premium: 'YES' }))).toEqual({ premiumOnly: true });
  });

  it('combines all filters', () => {
    expect(
      masterExportFiltersFromQuery(
        mockReq({ brand: 'x', country: 'US', premium: 'true' })
      )
    ).toEqual({ brand: 'x', country: 'US', premiumOnly: true });
  });
});

describe('masterBrandPremiumScopeFromQuery', () => {
  it('returns undefined when no brand or premium', () => {
    expect(masterBrandPremiumScopeFromQuery(mockReq({}))).toBeUndefined();
    expect(masterBrandPremiumScopeFromQuery(mockReq({ country: 'US' }))).toBeUndefined();
  });

  it('parses brand and ignores country', () => {
    expect(masterBrandPremiumScopeFromQuery(mockReq({ brand: 'omega_stores', country: 'FR' }))).toEqual({
      brand: 'omega_stores',
    });
  });

  it('parses premium without brand', () => {
    expect(masterBrandPremiumScopeFromQuery(mockReq({ premium: 'true' }))).toEqual({ premiumOnly: true });
  });

  it('combines brand and premium', () => {
    expect(
      masterBrandPremiumScopeFromQuery(mockReq({ brand: 'x', premium: '1' }))
    ).toEqual({ brand: 'x', premiumOnly: true });
  });
});
