/**
 * Photon (OSM) forward geocode — Komoot public API by default.
 * https://github.com/komoot/photon — fair-use; throttle/ban risk for large batches (self-host for production bulk).
 */

import type { GeocodedPoint } from './coordinate-verification-decision';
/** Loads i18n-iso-countries English locale (needed for getAlpha2Code). */
import { normalizeCountry } from './country';
import * as isoCountries from 'i18n-iso-countries';
import { buildFreeformGeocodeQuery, type GeocodeAddressInput } from './geocode-address-format';
import {
  onPublicGeocoderHttpStatus,
  waitPublicGeocoderCooldown,
} from './geocoder-http-cooldown';
import { logger } from './logger';

type PhotonFeature = {
  geometry?: { type?: string; coordinates?: [number, number] };
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

function parsePhotonPoint(data: unknown): GeocodedPoint | null {
  const o = data as PhotonResponse;
  const coords = o.features?.[0]?.geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  const [lon, lat] = coords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function countryNameToPhotonCountrycode(raw: string): string | undefined {
  const name = normalizeCountry(raw);
  if (!name) return undefined;
  const code = isoCountries.getAlpha2Code(name, 'en');
  return code ? code.toLowerCase() : undefined;
}

/**
 * One `/api` request with free-text `q` (and optional `countrycode` filter).
 */
export async function geocodeAddressPhoton(
  input: GeocodeAddressInput,
  options: {
    baseUrl: string;
    /** Identifies your app; recommended on shared APIs. */
    userAgent: string;
    signal?: AbortSignal;
  }
): Promise<GeocodedPoint | null> {
  const ua = options.userAgent.trim();
  if (!ua) {
    throw new Error('NOMINATIM_USER_AGENT must be non-empty in src/config/geo-verify.ts (used as HTTP User-Agent for Photon too)');
  }

  const q = buildFreeformGeocodeQuery(input);
  if (!q) {
    return null;
  }

  const base = options.baseUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    q,
    limit: '1',
    lang: 'en',
  });
  const cc = countryNameToPhotonCountrycode(input.country);
  if (cc) {
    params.append('countrycode', cc);
  }

  const url = `${base}/api?${params.toString()}`;

  await waitPublicGeocoderCooldown();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': ua,
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
    signal: options.signal,
  });

  const status = res.status;
  if (!res.ok) {
    onPublicGeocoderHttpStatus(status);
    if (status !== 429) {
      logger.warn(`[photon] HTTP ${status} (no result)`);
    }
    return null;
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    onPublicGeocoderHttpStatus(status);
    return null;
  }

  onPublicGeocoderHttpStatus(status);
  return parsePhotonPoint(data);
}
