import { describe, expect, it } from 'vitest';
import { decideCoordinateCorrection } from '../../utils/coordinate-verification-decision';

describe('decideCoordinateCorrection', () => {
  const maxDrift = 225;

  it('returns no_geocode when geocoder returns null', () => {
    expect(decideCoordinateCorrection(40.7, -74.0, null, maxDrift)).toBe('no_geocode');
  });

  it('replaces unusable coords when geocode exists', () => {
    expect(decideCoordinateCorrection(0, 0, { lat: 40.7128, lon: -74.006 }, maxDrift)).toBe('replace');
  });

  it('keeps when within max drift', () => {
    const lat = 48.8566;
    const lon = 2.3522;
    const nearLat = lat + 0.0005;
    expect(decideCoordinateCorrection(lat, lon, { lat: nearLat, lon }, maxDrift)).toBe('keep');
  });

  it('replaces when beyond max drift', () => {
    const lat = 48.8566;
    const lon = 2.3522;
    const farLat = lat + 0.05;
    expect(decideCoordinateCorrection(lat, lon, { lat: farLat, lon }, maxDrift)).toBe('replace');
  });
});
