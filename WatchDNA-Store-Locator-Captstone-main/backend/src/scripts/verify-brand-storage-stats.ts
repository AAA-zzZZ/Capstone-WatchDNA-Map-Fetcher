/**
 * Report how brand data is stored: repeated legacy CSV vs normalized Brand rows.
 *
 *   npx ts-node src/scripts/verify-brand-storage-stats.ts
 */
import 'dotenv/config';

import prisma from '../lib/prisma';

/** Normalized tables may exist in DB (migration 20260408120000) but are not on the Prisma client. */
async function countDistinctLocationsWithBrandLinks(): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(DISTINCT "locationId")::bigint AS c FROM "LocationBrand"
    `;
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function countBrandRows(): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "Brand"
    `;
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

async function main() {
  const [locWithBrandsCol, locWithLinks, brandCount, topRepeated] = await Promise.all([
    prisma.location.count({ where: { brands: { not: null } } }),
    countDistinctLocationsWithBrandLinks(),
    countBrandRows(),
    prisma.$queryRaw<{ brands: string; cnt: bigint }[]>`
      SELECT "brands", COUNT(*)::bigint AS cnt
      FROM "Location"
      WHERE "brands" IS NOT NULL AND trim("brands") <> ''
      GROUP BY "brands"
      ORDER BY cnt DESC
      LIMIT 15
    `,
  ]);

  console.log('--- Brand storage snapshot ---');
  console.log(`Location rows with non-null legacy "brands" column: ${locWithBrandsCol}`);
  console.log(`Location rows with at least one LocationBrand link: ${locWithLinks}`);
  console.log(`Distinct Brand rows (canonical display names): ${brandCount}`);
  if (topRepeated.length > 0) {
    console.log('\nTop repeated legacy "brands" strings (same text on many rows = redundant storage):');
    for (const row of topRepeated) {
      console.log(`  ${row.cnt}x  ${(row.brands ?? '').slice(0, 80)}${(row.brands?.length ?? 0) > 80 ? '…' : ''}`);
    }
  } else {
    console.log('\nNo non-empty legacy brands column values (already migrated or empty DB).');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
