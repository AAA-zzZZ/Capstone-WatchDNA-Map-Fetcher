/**
 * Tier C dedupe dry-run: print counts only (no per-merge output).
 *
 * Usage: npx tsx src/scripts/dedupe-dry-run-summary.ts
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import { buildDedupPlans, GEO_PROXIMITY_M, MAX_GROUP_SPREAD_M } from '../utils/location-merge-core';
import type { MergeStoreRow } from '../utils/location-merge-core';

async function main() {
  const rows = (await prisma.location.findMany({
    select: {
      handle: true,
      name: true,
      brands: true,
      customBrands: true,
      tags: true,
      addressLine1: true,
      city: true,
      country: true,
      latitude: true,
      longitude: true,
      isPremium: true,
      updatedAt: true,
    },
    orderBy: { handle: 'asc' },
  })) as MergeStoreRow[];

  const plans = buildDedupPlans(rows);
  const fpPlans = plans.filter((p) => p.label === 'address-fingerprint');
  const geoPlans = plans.filter((p) => p.label === 'geo-proximity');
  const rowsToRemove = plans.reduce((n, p) => n + p.remove.length, 0);

  console.log('DRY-RUN (no DB writes)\n');
  console.log(`Total Location rows scanned:     ${rows.length}`);
  console.log(`Merge groups (would run):        ${plans.length}`);
  console.log(`  address-fingerprint (spread ≤ ${MAX_GROUP_SPREAD_M}m): ${fpPlans.length}`);
  console.log(`  geo-proximity (≤ ${GEO_PROXIMITY_M}m, different fp):     ${geoPlans.length}`);
  console.log(`Duplicate rows to remove:        ${rowsToRemove}`);
  console.log(`Locations after merge:           ${rows.length - rowsToRemove}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
