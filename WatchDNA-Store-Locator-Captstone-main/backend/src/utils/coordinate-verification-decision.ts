import { haversineDistanceMeters, isUnusableScraperCoordinate } from './geo-dedupe';

export type GeocodedPoint = { lat: number; lon: number };

export type CoordinateVerificationDecision = 'no_geocode' | 'keep' | 'replace';

/**
 * Given existing WGS84 coords and a Nominatim result, decide whether to keep or replace stored coords.
 */
export function decideCoordinateCorrection(
  existingLat: number,
  existingLon: number,
  geocoded: GeocodedPoint | null,
  maxDriftMeters: number
): CoordinateVerificationDecision {
  if (!geocoded) return 'no_geocode';
  if (isUnusableScraperCoordinate(existingLat, existingLon)) return 'replace';
  const d = haversineDistanceMeters(existingLat, existingLon, geocoded.lat, geocoded.lon);
  if (d <= maxDriftMeters) return 'keep';
  return 'replace';
}
