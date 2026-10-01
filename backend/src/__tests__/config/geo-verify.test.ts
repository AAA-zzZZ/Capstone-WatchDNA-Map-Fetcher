import { describe, expect, it } from 'vitest';
import { readGeoVerifyConfig } from '../../config/geo-verify';

describe('readGeoVerifyConfig', () => {
  it('returns in-code settings', () => {
    const c = readGeoVerifyConfig();
    expect(c.enabled).toBe(true);
    expect(c.geocoder).toBe('photon');
    expect(c.nominatimBaseUrl).toBe('https://nominatim.openstreetmap.org');
    expect(c.photonBaseUrl).toBe('https://photon.komoot.io');
    expect(c.nominatimUserAgent.length).toBeGreaterThan(0);
    expect(c.minIntervalMs).toBe(2200);
    expect(c.maxDriftMeters).toBe(225);
  });
});
