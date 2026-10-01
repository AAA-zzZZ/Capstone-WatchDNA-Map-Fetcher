import { describe, expect, it } from 'vitest';

import { effectiveBrandsCsvFromLocation } from '../../utils/location-brands';

describe('effectiveBrandsCsvFromLocation', () => {
  it('prefers linked brands sorted', () => {
    expect(
      effectiveBrandsCsvFromLocation({
        brands: 'LEGACY',
        locationBrands: [
          { brand: { displayName: 'ZETA' } },
          { brand: { displayName: 'ALPHA' } },
        ],
      })
    ).toBe('ALPHA, ZETA');
  });

  it('falls back to legacy column when no links', () => {
    expect(
      effectiveBrandsCsvFromLocation({
        brands: 'OMEGA, ROLEX',
        locationBrands: [],
      })
    ).toBe('OMEGA, ROLEX');
  });
});
