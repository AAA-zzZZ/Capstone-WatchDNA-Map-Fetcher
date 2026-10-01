import { normalizeCountry } from './country';

/**
 * Last-resort pure-proximity merge radius (m). Intentionally tight — only meant to absorb geocoding
 * drift between data sources for the exact same building. 75 m is enough for any real drift while
 * preventing neighbouring stores in a shopping centre from collapsing into one record.
 */
export const PROXIMITY_MERGE_MAX_METERS = 75;

/**
 * Max distance (m) allowed when an address fingerprint exactly matches (same normalised line1 + city +
 * country). Accepts slight geocoding provider disagreement but rejects "23 High St" in different parts
 * of the same city.
 */
export const ADDRESS_FP_EXACT_MAX_METERS = 300;

/**
 * Max distance (m) allowed when one address fingerprint contains the other (e.g. "marinamall" inside
 * "marinamall unit 4"). Tighter than the exact match because containment is a weaker signal.
 */
export const ADDRESS_FP_CONTAIN_MAX_METERS = 150;

const EARTH_RADIUS_M = 6371000;

/**
 * Great-circle distance between two WGS84 points in metres.
 */
export function haversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);
  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Approximate latitude span (degrees) for a north–south distance in metres.
 */
export function metersToLatitudeDelta(meters: number): number {
  return meters / 111_320;
}

/**
 * Approximate longitude span (degrees) for an east–west distance at a given latitude.
 */
export function metersToLongitudeDelta(meters: number, latitudeDeg: number): number {
  const cosLat = Math.cos((latitudeDeg * Math.PI) / 180);
  const denom = 111_320 * Math.max(Math.abs(cosLat), 0.01);
  return meters / denom;
}

export type LatLonBoundingBox = {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
};

/**
 * Axis-aligned bounding box containing all points within `maxMeters` of (lat, lon).
 */
export function boundingBoxForRadiusMeters(
  lat: number,
  lon: number,
  maxMeters: number
): LatLonBoundingBox {
  const dLat = metersToLatitudeDelta(maxMeters);
  const dLon = metersToLongitudeDelta(maxMeters, lat);
  return {
    latMin: lat - dLat,
    latMax: lat + dLat,
    lonMin: lon - dLon,
    lonMax: lon + dLon,
  };
}

export function countriesMatchForDedupe(a: string, b: string): boolean {
  return normalizeCountry(a) === normalizeCountry(b);
}

export type GeoPoint = { latitude: number; longitude: number };

/**
 * Among candidates, return the closest to (lat, lon) if within maxMeters; otherwise null.
 */
export function pickNearestWithin<T extends GeoPoint>(
  candidates: T[],
  lat: number,
  lon: number,
  maxMeters: number
): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = haversineDistanceMeters(lat, lon, c.latitude, c.longitude);
    if (d <= maxMeters && d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/**
 * Extended proximity radius (m) used only when the incoming store name normalizes to the same
 * value as the candidate. Looser than PROXIMITY_MERGE_MAX_METERS because the matching store name
 * is a strong additional signal — absorbs geocoder disagreement on non-Latin addresses where the
 * same street can be transliterated completely differently across data sources.
 */
export const PROXIMITY_MERGE_NAME_MATCH_MAX_METERS = 300;

/**
 * When store names are clearly the same retailer but not identical ("… Inc.", JP dept-store variants),
 * allow a wider proximity merge than {@link PROXIMITY_MERGE_NAME_MATCH_MAX_METERS}. Same tower / mall
 * geocode variance and tall buildings should stay inside this radius.
 */
export const PROXIMITY_MERGE_SIMILAR_NAME_MAX_METERS = 550;

/**
 * Alnum-only, lowercase name fingerprint for name-similarity dedupe.
 * "ACCENT" and "Accent" collapse to the same key; whitespace and punctuation are stripped.
 */
export function normalizeNameForDedupe(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const TRAILING_ORG_SUFFIX_RE =
  /(inc|llc|ltd|limited|corporation|corp|company|gmbh|srl|nv|plc)+$/g;

const ORG_SUFFIX_TOKENS = new Set([
  'inc', 'llc', 'ltd', 'limited', 'corporation', 'corp', 'company', 'gmbh', 'srl', 'nv', 'plc',
]);

function stripTrailingOrgSuffixTokens(normalized: string): string {
  let s = normalized;
  let prev = '';
  while (s !== prev) {
    prev = s;
    s = s.replace(TRAILING_ORG_SUFFIX_RE, '');
  }
  return s;
}

/** Lowercase word tokens (alnum runs) minus org-suffix tokens, for order-free name comparison. */
function nameTokensForDedupe(name: string): string[] {
  return (name ?? '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0 && !ORG_SUFFIX_TOKENS.has(t));
}

/**
 * True when two display names almost certainly refer to the same retailer (suffix variants, long shared
 * prefix for department-store / building names). Used only together with tight geography checks.
 */
export function namesSimilarForDedupe(nameA: string, nameB: string): boolean {
  const a = normalizeNameForDedupe(nameA);
  const b = normalizeNameForDedupe(nameB);
  if (!a || !b) return false;
  if (a === b) return true;

  const aSt = stripTrailingOrgSuffixTokens(a);
  const bSt = stripTrailingOrgSuffixTokens(b);
  if (aSt === bSt) return true;

  const [shorter, longer] = aSt.length <= bSt.length ? [aSt, bSt] : [bSt, aSt];
  if (shorter.length < 8) return false;
  if (longer.startsWith(shorter)) return true;

  let prefix = 0;
  const max = Math.min(aSt.length, bSt.length);
  while (prefix < max && aSt[prefix] === bSt[prefix]) prefix++;
  if (prefix >= 14) return true;
  if (prefix >= 10 && prefix >= 0.55 * shorter.length) return true;

  // Number-prefixed retailer names: "13 Secrets Jewelry …" vs "13 Secrets Plant …" share "13secrets".
  if (/^\d/.test(aSt) && /^\d/.test(bSt) && prefix >= 9) return true;

  // Order-free token containment: "Boutique Zegg & Cerlati" vs "Zegg Cerlati" (and word-order swaps
  // like "Boutique IWC" vs "IWC Boutique"). Two tokens minimum on the shorter side so a lone generic
  // word ("Boutique") cannot bridge unrelated retailers.
  const aTokens = nameTokensForDedupe(nameA);
  const bTokens = nameTokensForDedupe(nameB);
  const [small, big] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
  if (small.length >= 2) {
    const bigSet = new Set(big);
    if (small.every((t) => bigSet.has(t))) return true;
  }

  return false;
}

/**
 * True when both names are present and almost certainly refer to DIFFERENT stores
 * ("Omega Boutique" vs "IWC Boutique" in the same building). Blank names never count as
 * distinct — an empty name cannot distinguish, so proximity/address rules keep deciding.
 * Used to block name-blind merge paths from collapsing separate boutiques at one address.
 */
export function namesClearlyDistinct(
  nameA: string | null | undefined,
  nameB: string | null | undefined
): boolean {
  const a = normalizeNameForDedupe(nameA ?? '');
  const b = normalizeNameForDedupe(nameB ?? '');
  if (!a || !b) return false;
  if (a === b) return false;
  return !namesSimilarForDedupe(nameA ?? '', nameB ?? '');
}

/**
 * Coordinates unsuitable for proximity dedupe (bad scraper placeholders).
 */
export function isUnusableScraperCoordinate(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return true;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return true;
  return false;
}
