/**
 * Merge Location rows that share the same dedupe address fingerprint (St vs Street, etc.),
 * same city, and same country, OR that are within a geo-proximity radius (catches transliteration
 * address variants). Phone differences never block merges — the survivor's phone is kept.
 *
 * This is Tier C in the deduplication pipeline (global scope, highest blast radius).
 * Always run in dry-run mode first and review the output before passing --execute.
 * See backend/src/utils/location-merge-core.ts for the confidence tier documentation.
 *
 * Usage:
 *   npx ts-node src/scripts/merge-address-duplicate-locations.ts
 *   npx ts-node src/scripts/merge-address-duplicate-locations.ts --execute
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import {
  buildDedupPlans,
  executeDedupPlans,
  GEO_PROXIMITY_M,
  MAX_GROUP_SPREAD_M,
} from '../utils/location-merge-core';

const execute = process.argv.includes('--execute');

async function loadLocations() {
  return prisma.location.findMany({ orderBy: { handle: 'asc' } });
}

async function main() {
  console.log(execute ? 'MODE: EXECUTE (writes to DB)\n' : 'MODE: DRY-RUN (no writes)\n');

  const all = await loadLocations();
  const plans = buildDedupPlans(all);

  const fpPlans = plans.filter((p) => p.label === 'address-fingerprint');
  const geoPlans = plans.filter((p) => p.label === 'geo-proximity');

  console.log(
    `Address-fingerprint merge groups (coords ≤ ${MAX_GROUP_SPREAD_M}m): ${fpPlans.length}`
  );
  for (const m of fpPlans) {
    console.log(`\nKeep ${m.keep.handle} | remove: ${m.remove.map((r) => r.handle).join(', ')}`);
    console.log(`  ${m.keep.addressLine1} / ${m.mergedName}`);
  }

  console.log(
    `\nGeo-proximity merge groups (≤ ${GEO_PROXIMITY_M}m, different address format): ${geoPlans.length}`
  );
  for (const m of geoPlans) {
    console.log(`\nKeep ${m.keep.handle} | remove: ${m.remove.map((r) => r.handle).join(', ')}`);
    console.log(`  [${m.label}] ${m.keep.addressLine1} / ${m.mergedName}`);
    for (const r of m.remove) console.log(`    ← ${r.addressLine1} / ${r.name}`);
  }

  console.log(`\nTotal merge groups: ${plans.length}`);

  if (!execute) {
    console.log('\nPass --execute to merge into survivors and delete duplicate rows.');
    return;
  }

  const removed = await executeDedupPlans(plans);
  const remaining = await prisma.location.count();
  console.log(`\nDone. Merged ${plans.length} groups, removed ${removed} duplicate row(s). Locations remaining: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
