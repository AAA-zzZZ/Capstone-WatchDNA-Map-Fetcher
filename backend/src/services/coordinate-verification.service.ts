import prisma from '../lib/prisma';
import { readGeoVerifyConfig } from '../config/geo-verify';
import { addressKeyForGeoVerification } from '../utils/address-key-geo-verification';
import {
  decideCoordinateCorrection,
  type GeocodedPoint,
} from '../utils/coordinate-verification-decision';
import {
  geocodeAddressNominatim,
  type NominatimAddressInput,
} from '../utils/nominatim-geocode';
import { geocodeAddressPhoton } from '../utils/photon-geocode';
import { logger } from '../utils/logger';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type VerifyHandlesOptions = {
  dryRun?: boolean;
  /** Re-run geocode even when a prior verification stamp matches the address key (only when DB columns exist). */
  forceReverify?: boolean;
  /** For tests only — bypasses HTTP when set */
  geocodeFn?: (input: NominatimAddressInput) => Promise<GeocodedPoint | null>;
  /** Called after each handle is processed (checked, skipped, failed, or errored). */
  onProgress?: (processed: number, total: number) => void;
};

export type VerifyHandlesSummary = {
  checked: number;
  skippedAlreadyVerified: number;
  coordinatesUpdated: number;
  verifiedStampOnly: number;
  geocodeFailed: number;
  errors: number;
};

let cachedHasVerificationColumns: boolean | null = null;

async function locationHasVerificationColumns(): Promise<boolean> {
  if (cachedHasVerificationColumns !== null) return cachedHasVerificationColumns;
  const rows = await prisma.$queryRaw<{ present: bigint }[]>`
    SELECT 1::bigint AS present
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Location'
      AND column_name = 'coordinatesVerifiedAt'
    LIMIT 1
  `;
  cachedHasVerificationColumns = rows.length > 0;
  return cachedHasVerificationColumns;
}

async function throttleAfterRequest(minIntervalMs: number, lastEnd: { t: number }): Promise<void> {
  const elapsed = Date.now() - lastEnd.t;
  const wait = minIntervalMs - elapsed;
  if (wait > 0) await sleep(wait);
}

function buildNominatimInput(row: {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
}): NominatimAddressInput {
  return {
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    stateProvinceRegion: row.stateProvinceRegion,
    postalCode: row.postalCode,
    country: row.country,
  };
}

type RowForVerify = {
  handle: string;
  latitude: number;
  longitude: number;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
  coordinatesVerifiedAt: Date | null;
  coordinatesVerificationAddressKey: string | null;
};

async function loadRowForVerify(handle: string, hasStampCols: boolean): Promise<RowForVerify | null> {
  if (!hasStampCols) {
    const r = await prisma.location.findUnique({
      where: { handle },
      select: {
        handle: true,
        latitude: true,
        longitude: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        stateProvinceRegion: true,
        postalCode: true,
        country: true,
      },
    });
    if (!r) return null;
    return { ...r, coordinatesVerifiedAt: null, coordinatesVerificationAddressKey: null };
  }

  const rows = await prisma.$queryRaw<RowForVerify[]>`
    SELECT
      "handle",
      "latitude",
      "longitude",
      "addressLine1",
      "addressLine2",
      "city",
      "stateProvinceRegion",
      "postalCode",
      "country",
      "coordinatesVerifiedAt",
      "coordinatesVerificationAddressKey"
    FROM "Location"
    WHERE "handle" = ${handle}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Sequential geocoder verification for the given handles (rate-limited).
 * When optional `coordinatesVerifiedAt` / `coordinatesVerificationAddressKey` columns exist,
 * skips rows already verified for the same address key unless `forceReverify`.
 */
export async function verifyHandles(
  handles: string[],
  options?: VerifyHandlesOptions
): Promise<VerifyHandlesSummary> {
  const summary: VerifyHandlesSummary = {
    checked: 0,
    skippedAlreadyVerified: 0,
    coordinatesUpdated: 0,
    verifiedStampOnly: 0,
    geocodeFailed: 0,
    errors: 0,
  };

  const unique = [...new Set(handles.filter((h) => h && h.trim()))];
  if (unique.length === 0) return summary;

  const hasStampCols = await locationHasVerificationColumns();

  const config = readGeoVerifyConfig();
  const geocode =
    options?.geocodeFn ??
    ((input: NominatimAddressInput) =>
      config.geocoder === 'photon'
        ? geocodeAddressPhoton(input, {
            baseUrl: config.photonBaseUrl,
            userAgent: config.nominatimUserAgent,
          })
        : geocodeAddressNominatim(input, {
            baseUrl: config.nominatimBaseUrl,
            userAgent: config.nominatimUserAgent,
            minIntervalMs: config.minIntervalMs,
          }));

  const lastEnd = { t: 0 };
  let processedCount = 0;

  for (const handle of unique) {
    try {
      const row = await loadRowForVerify(handle, hasStampCols);

      if (!row) {
        summary.errors++;
        continue;
      }

      summary.checked++;
      const keyNow = addressKeyForGeoVerification(row);

      if (
        hasStampCols &&
        !options?.forceReverify &&
        row.coordinatesVerifiedAt != null &&
        row.coordinatesVerificationAddressKey != null &&
        row.coordinatesVerificationAddressKey === keyNow
      ) {
        summary.skippedAlreadyVerified++;
        continue;
      }

      if (!options?.geocodeFn) {
        if (!config.nominatimUserAgent) {
          logger.warn(
            `[coordinateVerification] NOMINATIM_USER_AGENT is empty in geo-verify config; skipping geocode for handle ${handle}`
          );
          summary.geocodeFailed++;
          continue;
        }
        await throttleAfterRequest(config.minIntervalMs, lastEnd);
      }

      const nomInput = buildNominatimInput(row);
      let point: GeocodedPoint | null;
      try {
        point = await geocode(nomInput);
      } catch (e: unknown) {
        logger.warn(`[coordinateVerification] Geocode error for ${handle}: ${String(e)}`);
        summary.geocodeFailed++;
        lastEnd.t = Date.now();
        continue;
      }
      lastEnd.t = Date.now();

      const decision = decideCoordinateCorrection(
        row.latitude,
        row.longitude,
        point,
        config.maxDriftMeters
      );

      if (decision === 'no_geocode') {
        summary.geocodeFailed++;
        continue;
      }

      const now = new Date();
      if (decision === 'replace') {
        if (options?.dryRun) {
          logger.info(
            `[coordinateVerification] dry-run: would replace coords for ${handle} with lat=${point!.lat} lon=${point!.lon}`
          );
          summary.coordinatesUpdated++;
          continue;
        }
        if (hasStampCols) {
          await prisma.$executeRaw`
            UPDATE "Location"
            SET
              "latitude" = ${point!.lat},
              "longitude" = ${point!.lon},
              "coordinatesVerifiedAt" = ${now},
              "coordinatesVerificationAddressKey" = ${keyNow}
            WHERE "handle" = ${row.handle}
          `;
        } else {
          await prisma.location.update({
            where: { handle: row.handle },
            data: {
              latitude: point!.lat,
              longitude: point!.lon,
            },
          });
        }
        summary.coordinatesUpdated++;
        continue;
      }

      if (options?.dryRun) {
        logger.info(`[coordinateVerification] dry-run: would stamp verified only for ${handle}`);
        summary.verifiedStampOnly++;
        continue;
      }
      if (hasStampCols) {
        await prisma.$executeRaw`
          UPDATE "Location"
          SET
            "coordinatesVerifiedAt" = ${now},
            "coordinatesVerificationAddressKey" = ${keyNow}
          WHERE "handle" = ${row.handle}
        `;
      }
      summary.verifiedStampOnly++;
    } catch (e: unknown) {
      logger.error(`[coordinateVerification] handle ${handle}: ${String(e)}`);
      summary.errors++;
    } finally {
      processedCount++;
      options?.onProgress?.(processedCount, unique.length);
    }
  }

  return summary;
}

/**
 * Whether post-ingest verification should run (env toggle).
 */
export function isGeoVerifyEnabledForIngest(): boolean {
  return readGeoVerifyConfig().enabled;
}

/**
 * After CSV/scraper upsert: rate-limited Nominatim checks for processed handles.
 * No-ops when disabled or handles empty. Errors are logged, not thrown.
 */
export async function runGeoVerifyAfterIngestIfEnabled(
  processedHandles: string[] | undefined
): Promise<VerifyHandlesSummary | null> {
  if (!processedHandles?.length || !isGeoVerifyEnabledForIngest()) {
    return null;
  }
  try {
    const summary = await verifyHandles(processedHandles);
    logger.info(`[coordinateVerification] post-ingest: ${JSON.stringify(summary)}`);
    return summary;
  } catch (e: unknown) {
    logger.warn(`[coordinateVerification] post-ingest failed: ${String(e)}`);
    return null;
  }
}
