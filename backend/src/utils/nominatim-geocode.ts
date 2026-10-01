import type { GeocodedPoint } from './coordinate-verification-decision';
import {
  buildFreeformGeocodeQuery,
  buildStreetLineForGeocode,
  type GeocodeAddressInput,
} from './geocode-address-format';
import {
  onPublicGeocoderHttpStatus,
  resetPublicGeocoderRateLimitForTests,
  waitPublicGeocoderCooldown,
} from './geocoder-http-cooldown';
import { logger } from './logger';

export type NominatimAddressInput = GeocodeAddressInput;

type NominatimSearchRow = { lat?: string; lon?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** @deprecated use resetPublicGeocoderRateLimitForTests */
export function resetNominatimRateLimitStateForTests(): void {
  resetPublicGeocoderRateLimitForTests();
}

function parseNominatimSearchArray(data: unknown): GeocodedPoint | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const row = data[0] as NominatimSearchRow;
  if (typeof row.lat !== 'string' || typeof row.lon !== 'string') {
    return null;
  }
  const lat = parseFloat(row.lat);
  const lon = parseFloat(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }
  return { lat, lon };
}

async function fetchNominatimSearch(
  fullUrl: string,
  userAgent: string,
  signal?: AbortSignal
): Promise<{ status: number; point: GeocodedPoint | null }> {
  const res = await fetch(fullUrl, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
    signal,
  });

  const status = res.status;
  if (!res.ok) {
    return { status, point: null };
  }

  try {
    const data = await res.json();
    return { status, point: parseNominatimSearchArray(data) };
  } catch {
    return { status, point: null };
  }
}

async function nominatimGet(
  fullUrl: string,
  userAgent: string,
  signal?: AbortSignal
): Promise<{ status: number; point: GeocodedPoint | null }> {
  await waitPublicGeocoderCooldown();
  const out = await fetchNominatimSearch(fullUrl, userAgent, signal);
  onPublicGeocoderHttpStatus(out.status);
  return out;
}

function buildStructuredSearchParams(input: GeocodeAddressInput): URLSearchParams {
  const params = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    street: buildStreetLineForGeocode(input.addressLine1, input.addressLine2),
    city: input.city.trim(),
    country: input.country.trim(),
  });
  const state = (input.stateProvinceRegion ?? '').trim();
  if (state) params.set('state', state);
  const postal = (input.postalCode ?? '').trim();
  if (postal) params.set('postalcode', postal);
  return params;
}

/**
 * Forward geocode via Nominatim (jsonv2): structured search first, then free-form `q=` if empty.
 * Caller must pass a valid User-Agent per OSM usage policy.
 */
export async function geocodeAddressNominatim(
  input: GeocodeAddressInput,
  options: {
    baseUrl: string;
    userAgent: string;
    signal?: AbortSignal;
    /** Pause before a second request when using the `q=` fallback (rate limiting). */
    minIntervalMs?: number;
  }
): Promise<GeocodedPoint | null> {
  const ua = options.userAgent.trim();
  if (!ua) {
    throw new Error('NOMINATIM_USER_AGENT must be non-empty in src/config/geo-verify.ts');
  }

  const base = options.baseUrl.replace(/\/$/, '');
  const minIntervalMs = options.minIntervalMs ?? 2200;

  const structuredParams = buildStructuredSearchParams(input);
  const structuredUrl = `${base}/search?${structuredParams.toString()}`;
  const r1 = await nominatimGet(structuredUrl, ua, options.signal);
  if (r1.point) {
    return r1.point;
  }
  if (r1.status === 429) {
    return null;
  }
  if (r1.status !== 200) {
    logger.warn(`[nominatim] structured search HTTP ${r1.status} (no result)`);
    return null;
  }

  const q = buildFreeformGeocodeQuery(input);
  if (!q) {
    return null;
  }

  await sleep(minIntervalMs);
  const qParams = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    q,
  });
  const qUrl = `${base}/search?${qParams.toString()}`;
  const r2 = await nominatimGet(qUrl, ua, options.signal);
  if (r2.point) {
    return r2.point;
  }
  if (r2.status !== 200) {
    logger.warn(`[nominatim] free-form search HTTP ${r2.status} (no result)`);
  }
  return null;
}
