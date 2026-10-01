/**
 * Tier C dedupe dry-run: list each merge group with full addresses (line 1 + line 2).
 * Does not write to the database.
 *
 * Usage: npx tsx src/scripts/dedupe-dry-run-list.ts
 */
import 'dotenv/config';
import prisma from '../lib/prisma';
import { buildDedupPlans, type MergeStoreRow } from '../utils/location-merge-core';

type RowWithLine2 = MergeStoreRow & { addressLine2: string | null };

function fmtAddr(line1: string, line2: string | null | undefined): string {
  const a = (line1 ?? '').trim();
  const b = (line2 ?? '').trim();
  if (!b) return a || '(empty)';
  return `${a} | ${b}`;
}

async function main() {
  const rows = (await prisma.location.findMany({
    select: {
      handle: true,
      name: true,
      brands: true,
      customBrands: true,
      tags: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      country: true,
      latitude: true,
      longitude: true,
      isPremium: true,
      updatedAt: true,
    },
    orderBy: { handle: 'asc' },
  })) as RowWithLine2[];

  const plans = buildDedupPlans(rows);

  console.log('DRY-RUN — rows listed below would be REMOVED (losers); survivor is KEEP.\n');

  let i = 0;
  for (const p of plans) {
    i++;
    const k = rows.find((r) => r.handle === p.keep.handle) ?? (p.keep as RowWithLine2);
    console.log(`${'='.repeat(72)}`);
    console.log(`Group ${i}/${plans.length}  [${p.label}]`);
    console.log(`City: ${k.city?.trim() ?? ''}  |  Country: ${k.country ?? ''}`);
    console.log('');
    console.log(`  KEEP   ${k.handle}`);
    console.log(`         ${k.name?.trim() ?? ''}`);
    console.log(`         ${fmtAddr(k.addressLine1, k.addressLine2)}`);
    for (const r of p.remove) {
      const full = rows.find((x) => x.handle === r.handle) ?? (r as RowWithLine2);
      console.log('');
      console.log(`  REMOVE ${full.handle}`);
      console.log(`         ${full.name?.trim() ?? ''}`);
      console.log(`         ${fmtAddr(full.addressLine1, full.addressLine2)}`);
    }
    console.log('');
  }

  console.log(`${'='.repeat(72)}`);
  console.log(`Total groups: ${plans.length}`);
  console.log(`Total REMOVE rows: ${plans.reduce((n, x) => n + x.remove.length, 0)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
