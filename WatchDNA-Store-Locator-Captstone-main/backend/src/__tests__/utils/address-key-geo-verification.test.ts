import { describe, expect, it } from 'vitest';
import { addressKeyForGeoVerification } from '../../utils/address-key-geo-verification';

describe('addressKeyForGeoVerification', () => {
  it('is stable for same logical address', () => {
    const a = addressKeyForGeoVerification({
      addressLine1: '  123 Main St ',
      addressLine2: null,
      city: 'Paris',
      stateProvinceRegion: null,
      postalCode: '75001',
      country: 'FR',
    });
    const b = addressKeyForGeoVerification({
      addressLine1: '123 main st',
      addressLine2: '',
      city: 'paris',
      stateProvinceRegion: '',
      postalCode: '75001',
      country: 'France',
    });
    expect(a).toBe(b);
  });

  it('changes when line1 changes', () => {
    const a = addressKeyForGeoVerification({
      addressLine1: '1 A St',
      addressLine2: null,
      city: 'X',
      stateProvinceRegion: null,
      postalCode: null,
      country: 'United States',
    });
    const b = addressKeyForGeoVerification({
      addressLine1: '2 A St',
      addressLine2: null,
      city: 'X',
      stateProvinceRegion: null,
      postalCode: null,
      country: 'United States',
    });
    expect(a).not.toBe(b);
  });
});
