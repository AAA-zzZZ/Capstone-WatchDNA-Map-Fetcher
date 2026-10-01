/**
 * Coordinate verification / forward geocode — edit constants here.
 * Nominatim policy: https://operations.osmfoundation.org/policies/nominatim/
 * Use a real app name + contact URL or email in the User-Agent (Photon and Nominatim).
 */

/** When true, scraper and CSV import runs verify processed handles after upsert. */
export const GEO_VERIFY_ENABLED_FOR_INGEST = true;

/** Override with env while bulk-running `verify-store-coordinates`: GEO_VERIFY_ENABLED_FOR_INGEST=false */
function effectiveGeoVerifyIngestEnabled(): boolean {
  const v = process.env.GEO_VERIFY_ENABLED_FOR_INGEST;
  if (v == null || v === '') return GEO_VERIFY_ENABLED_FOR_INGEST;
  const t = v.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  return GEO_VERIFY_ENABLED_FOR_INGEST;
}

export type GeocodeProvider = 'photon' | 'nominatim';

/**
 * photon — Komoot public API, one request/row, often better on messy international addresses.
 * nominatim — structured + q= (two requests when fallback needed).
 * Override: GEO_VERIFY_GEOCODER=nominatim|photon
 */
export const GEO_VERIFY_GEOCODER: GeocodeProvider = 'photon';

function effectiveGeocoder(): GeocodeProvider {
  const v = process.env.GEO_VERIFY_GEOCODER?.trim().toLowerCase();
  if (v === 'nominatim' || v === 'photon') return v;
  return GEO_VERIFY_GEOCODER;
}

/** Public Nominatim or your self-hosted base (no trailing slash). */
export const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';

/** Komoot public Photon or your self-hosted base (no trailing slash). */
export const PHOTON_BASE_URL = 'https://photon.komoot.io';

/**
 * Required by Nominatim — identify your application.
 * Replace the parenthetical with your support email or project URL before production use.
 */
export const NOMINATIM_USER_AGENT = 'WatchDNA-StoreLocator/1.0 (https://example.com/contact)';

/**
 * Minimum spacing between verifyHandles rows (and between Nominatim structured vs `q=`).
 * Public APIs are strict; increase if you still see 429. With photon only, 2s is often enough.
 */
export const GEO_VERIFY_MIN_INTERVAL_MS = 2200;

/** If stored coords are farther than this from the geocoded point, replace with geocoded (meters). */
export const GEO_VERIFY_MAX_DRIFT_METERS = 225;

export type GeoVerifyConfig = {
  enabled: boolean;
  geocoder: GeocodeProvider;
  nominatimBaseUrl: string;
  photonBaseUrl: string;
  nominatimUserAgent: string;
  minIntervalMs: number;
  maxDriftMeters: number;
};

export function readGeoVerifyConfig(): GeoVerifyConfig {
  const nomBase = NOMINATIM_BASE_URL.replace(/\/$/, '');
  const photonBase = PHOTON_BASE_URL.replace(/\/$/, '');
  return {
    enabled: effectiveGeoVerifyIngestEnabled(),
    geocoder: effectiveGeocoder(),
    nominatimBaseUrl: nomBase,
    photonBaseUrl: photonBase,
    nominatimUserAgent: NOMINATIM_USER_AGENT.trim(),
    minIntervalMs: GEO_VERIFY_MIN_INTERVAL_MS,
    maxDriftMeters: GEO_VERIFY_MAX_DRIFT_METERS,
  };
}
