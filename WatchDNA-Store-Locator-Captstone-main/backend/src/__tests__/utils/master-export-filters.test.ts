import { describe, it, expect } from 'vitest';

import { buildMasterExportWhere } from '../../utils/master-export-filters';

describe('buildMasterExportWhere', () => {
  it('returns empty object when filters undefined or empty', () => {
    expect(buildMasterExportWhere()).toEqual({});
    expect(buildMasterExportWhere({})).toEqual({});
  });

  it('sets isPremium when premiumOnly', () => {
    expect(buildMasterExportWhere({ premiumOnly: true })).toEqual({ isPremium: true });
  });

  it('country uses same resolved value as locations API for US', () => {
    const w = buildMasterExportWhere({ country: 'US' });
    expect(w).toEqual({ country: 'United States' });
  });

  it('ANDs brand, country, and premium', () => {
    const w = buildMasterExportWhere({
      brand: 'omega_stores',
      country: 'US',
      premiumOnly: true,
    });
    expect(w).toEqual({
      AND: [
        expect.objectContaining({ OR: expect.any(Array) }),
        { country: 'United States' },
        { isPremium: true },
      ],
    });
  });
});
