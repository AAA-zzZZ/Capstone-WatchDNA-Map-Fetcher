import { describe, it, expect } from 'vitest';
import {
  boundingBoxForRadiusMeters,
  countriesMatchForDedupe,
  haversineDistanceMeters,
  isUnusableScraperCoordinate,
  metersToLatitudeDelta,
  namesClearlyDistinct,
  namesSimilarForDedupe,
  pickNearestWithin,
  PROXIMITY_MERGE_MAX_METERS,
} from '../../utils/geo-dedupe';

describe('geo-dedupe', () => {
  it('haversineDistanceMeters is ~0 for identical points', () => {
    expect(haversineDistanceMeters(48.8566, 2.3522, 48.8566, 2.3522)).toBeLessThan(1);
  });

  it('haversineDistanceMeters matches known short span (~1 km order)', () => {
    const d = haversineDistanceMeters(48.8566, 2.3522, 48.8656, 2.3522);
    expect(d).toBeGreaterThan(900);
    expect(d).toBeLessThan(1100);
  });

  it('boundingBoxForRadiusMeters contains origin', () => {
    const lat = 40.7128;
    const lon = -74.006;
    const box = boundingBoxForRadiusMeters(lat, lon, 200);
    expect(box.latMin).toBeLessThanOrEqual(lat);
    expect(box.latMax).toBeGreaterThanOrEqual(lat);
    expect(box.lonMin).toBeLessThanOrEqual(lon);
    expect(box.lonMax).toBeGreaterThanOrEqual(lon);
  });

  it('metersToLatitudeDelta(111320) is about 1 degree', () => {
    expect(metersToLatitudeDelta(111_320)).toBeCloseTo(1, 1);
  });

  it('pickNearestWithin chooses closest under cap', () => {
    const refLat = 48.8566;
    const refLon = 2.3522;
    const candidates = [
      { latitude: refLat + 0.002, longitude: refLon, id: 'far' },
      { latitude: refLat + 0.00005, longitude: refLon, id: 'near' },
    ];
    const best = pickNearestWithin(candidates, refLat, refLon, 200);
    expect(best?.id).toBe('near');
  });

  it('pickNearestWithin returns null when all candidates exceed maxMeters', () => {
    const refLat = 48.8566;
    const refLon = 2.3522;
    const candidates = [{ latitude: refLat + 1, longitude: refLon, id: 'way' }];
    expect(pickNearestWithin(candidates, refLat, refLon, 100)).toBeNull();
  });

  it('isUnusableScraperCoordinate rejects NaN and 0,0', () => {
    expect(isUnusableScraperCoordinate(NaN, 1)).toBe(true);
    expect(isUnusableScraperCoordinate(0, 0)).toBe(true);
    expect(isUnusableScraperCoordinate(48.8566, 2.3522)).toBe(false);
  });

  it('countriesMatchForDedupe uses canonical country normalization', () => {
    expect(countriesMatchForDedupe('USA', 'United States')).toBe(true);
    expect(countriesMatchForDedupe('France', 'Germany')).toBe(false);
  });

  it('PROXIMITY_MERGE_MAX_METERS stays tight; name-aware passes require city + address gate', () => {
    expect(PROXIMITY_MERGE_MAX_METERS).toBeGreaterThanOrEqual(50);
    expect(PROXIMITY_MERGE_MAX_METERS).toBeLessThanOrEqual(150);
  });

  it('namesSimilarForDedupe handles Inc. suffix and long shared retailer prefixes', () => {
    expect(namesSimilarForDedupe('ABT Electronics', 'ABT Electronics Inc.')).toBe(true);
    expect(namesSimilarForDedupe('Air du Temps', 'AIR DU TEMPS')).toBe(true);
    expect(
      namesSimilarForDedupe(
        'ABENO HARUKAS KINTETSU HONTEN',
        'Abeno Harukas Kintetsu Dept Main Store Watch Salon'
      )
    ).toBe(true);
    expect(namesSimilarForDedupe('Omega Boutique', 'Breitling Store')).toBe(false);
  });

  it('namesSimilarForDedupe matches number-prefixed retailer variants (13 Secrets …)', () => {
    expect(
      namesSimilarForDedupe('13 SECRETS JEWELRY GALLERY', '13 Secrets Plant Riverside')
    ).toBe(true);
  });

  it('namesSimilarForDedupe matches word-order swaps and token containment', () => {
    expect(namesSimilarForDedupe('Boutique IWC', 'IWC Boutique')).toBe(true);
    expect(namesSimilarForDedupe('Boutique Zegg & Cerlati', 'Zegg Cerlati')).toBe(true);
    // A single shared generic token must not bridge unrelated retailers.
    expect(namesSimilarForDedupe('Omega Boutique', 'IWC Boutique')).toBe(false);
    expect(namesSimilarForDedupe('Boutique', 'Omega Boutique')).toBe(false);
  });

  it('namesClearlyDistinct separates different boutiques but not name variants or blanks', () => {
    expect(namesClearlyDistinct('Omega Boutique', 'IWC Boutique')).toBe(true);
    expect(namesClearlyDistinct('OMEGA Boutique', 'Omega Boutique Monte-Carlo')).toBe(false);
    expect(namesClearlyDistinct('ABT Electronics', 'ABT Electronics Inc.')).toBe(false);
    expect(namesClearlyDistinct('', 'IWC Boutique')).toBe(false);
    expect(namesClearlyDistinct(null, undefined)).toBe(false);
  });
});
