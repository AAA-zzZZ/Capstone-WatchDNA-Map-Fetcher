/**
 * Backfill or re-run Nominatim/Photon coordinate verification for Location rows.
 *
 * Geocoder (Photon vs Nominatim), URLs, User-Agent, rate limit, and drift are set in src/config/geo-verify.ts.
 *
 * Usage:
 *   npm run verify-store-coordinates
 *   ... --dry-run              # log actions, no DB writes
 *   ... --force                # re-verify all rows (ignore existing stamp)
 *   ... --limit 50             # max locations to process
 *   ... --brand "AUDEMARS PIGUET"  # restrict to stores carrying this brand
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import { readGeoVerifyConfig } from '../config/geo-verify';
import { verifyHandles } from '../services/coordinate-verification.service';
import { legacyBrandTextFilterWhere } from '../utils/legacy-brand-filter';

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const force = argv.includes('--force');
  let limit = Number.POSITIVE_INFINITY;
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx >= 0 && argv[limitIdx + 1]) {
    const n = parseInt(argv[limitIdx + 1], 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }
  let brand: string | null = null;
  const brandIdx = argv.indexOf('--brand');
  if (brandIdx >= 0 && argv[brandIdx + 1]) {
    brand = argv[brandIdx + 1]!;
  }
  return { dryRun, force, limit, brand };
}

async function hasVerificationStampColumn(): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ present: bigint }[]>`
    SELECT 1::bigint AS present
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'Location'
      AND column_name = 'coordinatesVerifiedAt'
    LIMIT 1
  `;
  return rows.length > 0;
}

async function main() {
  const { dryRun, force, limit, brand } = parseArgs(process.argv.slice(2));
  const config = readGeoVerifyConfig();
  const wallStart = Date.now();

  if (!config.nominatimUserAgent) {
    console.error('Set NOMINATIM_USER_AGENT in src/config/geo-verify.ts (required by Nominatim).');
    process.exit(1);
  }

  if (brand) {
    console.log(`Brand filter: "${brand}"`);
  }
  console.log(`Geocoder: ${config.geocoder}, interval floor: ${config.minIntervalMs}ms, drift cap: ${config.maxDriftMeters}m`);
  console.log(dryRun ? 'Mode: DRY-RUN (no writes)\n' : 'Mode: LIVE (will update DB)\n');

  let processed = 0;
  const totals = {
    checked: 0,
    skippedAlreadyVerified: 0,
    coordinatesUpdated: 0,
    verifiedStampOnly: 0,
    geocodeFailed: 0,
    errors: 0,
  };

  const hasStampCol = await hasVerificationStampColumn();
  const unverifiedOnly = hasStampCol && !force;

  // When a brand filter is set, load all matching handles up-front (typically a small set).
  if (brand) {
    const where = legacyBrandTextFilterWhere(brand);
    const rows = await prisma.location.findMany({
      where,
      select: { handle: true },
      orderBy: { id: 'asc' },
      take: Math.min(limit, 10_000),
    });
    console.log(`Found ${rows.length} stores for brand "${brand}"`);
    const handles = rows.map((r) => r.handle);
    const summary = await verifyHandles(handles, {
      dryRun,
      forceReverify: force || !hasStampCol,
    });
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
      totals[k] += summary[k];
    }
    processed = handles.length;
  } else {
    let lastId: string | null = null;
    let cursor: string | undefined;

    while (processed < limit) {
      const take = Math.min(100, limit - processed);
      let batch: { id: string; handle: string }[];

      if (unverifiedOnly) {
        batch =
          lastId === null
            ? await prisma.$queryRaw<{ id: string; handle: string }[]>`
                SELECT id, handle FROM "Location"
                WHERE "coordinatesVerifiedAt" IS NULL
                ORDER BY id ASC
                LIMIT ${take}
              `
            : await prisma.$queryRaw<{ id: string; handle: string }[]>`
                SELECT id, handle FROM "Location"
                WHERE "coordinatesVerifiedAt" IS NULL AND id > ${lastId}::uuid
                ORDER BY id ASC
                LIMIT ${take}
              `;
        lastId = batch.length ? batch[batch.length - 1]!.id : lastId;
      } else {
        batch = await prisma.location.findMany({
          take,
          orderBy: { id: 'asc' },
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          select: { id: true, handle: true },
        });
        cursor = batch.length ? batch[batch.length - 1]!.id : cursor;
      }

      if (batch.length === 0) break;

      const summary = await verifyHandles(batch.map((b) => b.handle), {
        dryRun,
        forceReverify: force || !hasStampCol,
      });
      for (const k of Object.keys(totals) as (keyof typeof totals)[]) {
        totals[k] += summary[k];
      }
      console.log(
        `batch ${batch[0].id.slice(0, 8)}…${batch.length} handles → ${JSON.stringify(summary)}`
      );

      processed += batch.length;
    }
  }

  const wallElapsedMs = Date.now() - wallStart;
  const avgSecPerHandle = processed > 0 ? (wallElapsedMs / 1000 / processed).toFixed(2) : 'N/A';
  console.log('\nDone. Totals:', JSON.stringify(totals, null, 2));
  console.log(
    `\nTiming: ${processed} handles in ${(wallElapsedMs / 1000).toFixed(1)}s` +
      ` (~${avgSecPerHandle}s per handle, geocoder interval floor: ${config.minIntervalMs}ms)`
  );
  if (processed > 0) {
    console.log(
      `Extrapolation guide: for N total locations, estimated time ≈ N × ${avgSecPerHandle}s` +
        ` (if all need geocoding)`
    );
  }
  if (!hasStampCol) {
    console.log(
      '\nNote: no coordinatesVerifiedAt column — full id-order pass (use --limit for partial runs).'
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
