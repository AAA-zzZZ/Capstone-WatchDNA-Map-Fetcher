import { logger } from './logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shared across all public OSM geocoder HTTP clients (Nominatim, Photon, …).
 * Prevents parallel “retry storms” when an IP is rate-limited.
 */
let geocoderCooldownUntilMs = 0;
let geocoder429Streak = 0;

export function resetPublicGeocoderRateLimitForTests(): void {
  geocoderCooldownUntilMs = 0;
  geocoder429Streak = 0;
}

export async function waitPublicGeocoderCooldown(): Promise<void> {
  const now = Date.now();
  if (now < geocoderCooldownUntilMs) {
    const wait = geocoderCooldownUntilMs - now;
    logger.warn(`[geocoder] global cooldown: sleeping ${Math.ceil(wait / 1000)}s before next request`);
    await sleep(wait);
  }
}

export function onPublicGeocoderHttpStatus(status: number): void {
  if (status === 429) {
    geocoder429Streak += 1;
    const waitMs = Math.min(900_000, 45_000 * 2 ** (geocoder429Streak - 1));
    geocoderCooldownUntilMs = Math.max(geocoderCooldownUntilMs, Date.now() + waitMs);
    logger.warn(
      `[geocoder] 429 Too Many Requests — backing off ${Math.ceil(waitMs / 1000)}s (streak ${geocoder429Streak}). ` +
        'Run one bulk job at a time; set GEO_VERIFY_ENABLED_FOR_INGEST=false during verify; or self-host Photon/Nominatim.'
    );
    return;
  }
  if (status === 200) {
    geocoder429Streak = 0;
  }
}
