/**
 * Remove incomplete Location rows and dedupe by stable handle (address + city + country + coords).
 *
 * Usage:
 *   npx ts-node src/scripts/cleanup-locations-db.ts           # dry-run (counts only)
 *   npx ts-node src/scripts/cleanup-locations-db.ts --execute # apply changes
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import { locationToCSVRow } from '../utils/csv-to-location';
import { isRowCompleteForDb } from '../utils/row-completeness';
import { computeStableHandleFromRow } from '../utils/stable-handle';

const execute = process.argv.includes('--execute');

function isIncompleteDbRow(loc: {
  name: string;
  addressLine1: string;
  addressLine2: string | null;
  latitude: number;
  longitude: number;
}): boolean {
  const addr1 = (loc.addressLine1 ?? '').trim();
  const addr2 = (loc.addressLine2 ?? '').trim();
  const name = (loc.name ?? '').trim();
  if (!name) return true;
  if (!addr1 && !addr2) return true;
  const { latitude: lat, longitude: lng } = loc;
  if (Number.isNaN(lat) || Number.isNaN(lng)) return true;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return true;
  if (lat === 0 && lng === 0) return true;
  return false;
}

async function main() {
  console.log(execute ? 'MODE: EXECUTE (writes to DB)\n' : 'MODE: DRY-RUN (no writes)\n');

  const all = await prisma.location.findMany({
    select: {
      id: true,
      handle: true,
      name: true,
      addressLine1: true,
      addressLine2: true,
      city: true,
      country: true,
      latitude: true,
      longitude: true,
      isPremium: true,
      updatedAt: true,
    },
  });

  const incompleteHandles = all.filter(isIncompleteDbRow).map((r) => r.handle);
  console.log(`Incomplete rows (no address, bad/missing coords, empty name): ${incompleteHandles.length}`);

  const complete = all.filter((r) => !isIncompleteDbRow(r));
  const groups = new Map<string, typeof complete>();
  for (const loc of complete) {
    const row = locationToCSVRow(loc);
    if (!isRowCompleteForDb(row)) continue;
    let key: string;
    try {
      key = computeStableHandleFromRow(row);
    } catch {
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(loc);
    groups.set(key, list);
  }

  const sortDupGroup = (
    a: (typeof complete)[0],
    b: (typeof complete)[0]
  ): number => {
    if (a.isPremium !== b.isPremium) return a.isPremium ? -1 : 1;
    const t = b.updatedAt.getTime() - a.updatedAt.getTime();
    if (t !== 0) return t;
    return a.handle.localeCompare(b.handle);
  };

  let dupGroups = 0;
  let dupRemovals = 0;
  const toDeleteDup: string[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    dupGroups++;
    members.sort(sortDupGroup);
    const keep = members[0]!;
    for (let i = 1; i < members.length; i++) {
      toDeleteDup.push(members[i]!.handle);
    }
    dupRemovals += members.length - 1;
  }

  const willDelete = new Set([...incompleteHandles, ...toDeleteDup]);
  const handleRenames: { from: string; to: string }[] = [];
  for (const [stableKey, members] of groups) {
    if (members.length < 2) continue;
    members.sort(sortDupGroup);
    const keep = members[0]!;
    if (keep.handle === stableKey) continue;
    const taken = all.some(
      (r) =>
        r.handle === stableKey && r.handle !== keep.handle && !willDelete.has(r.handle)
    );
    if (!taken) {
      handleRenames.push({ from: keep.handle, to: stableKey });
    }
  }

  console.log(`Duplicate groups (same stable geo key): ${dupGroups}`);
  console.log(`Duplicate rows to remove: ${dupRemovals}`);
  console.log(`Survivors to rename to loc_* handle: ${handleRenames.length}`);

  if (!execute) {
    console.log('\nPass --execute to delete incomplete + dupes and apply renames.');
    return;
  }

  // 1) PremiumStore cleanup for any handle we will remove
  const allRemoveHandles = [...new Set([...incompleteHandles, ...toDeleteDup])];
  if (allRemoveHandles.length > 0) {
    const prem = await prisma.premiumStore.deleteMany({
      where: { handle: { in: allRemoveHandles } },
    });
    console.log(`\nRemoved ${prem.count} PremiumStore rows for deleted handles.`);
  }

  // 2) Delete incomplete + duplicate losers
  if (allRemoveHandles.length > 0) {
    const del = await prisma.location.deleteMany({
      where: { handle: { in: allRemoveHandles } },
    });
    console.log(`Deleted ${del.count} Location rows (incomplete + duplicate).`);
  }

  // 3) Rename survivors to stable handle (PremiumStore PK: delete + recreate)
  for (const { from, to } of handleRenames) {
    const exists = await prisma.location.findUnique({ where: { handle: to } });
    if (exists) {
      console.log(`Skip rename ${from} -> ${to} (target exists)`);
      continue;
    }
    const prem = await prisma.premiumStore.findUnique({ where: { handle: from } });
    await prisma.location.update({
      where: { handle: from },
      data: { handle: to },
    });
    if (prem) {
      await prisma.premiumStore.delete({ where: { handle: from } });
      await prisma.premiumStore.create({
        data: { handle: to, notes: prem.notes ?? undefined },
      });
    }
    console.log(`Renamed handle ${from} -> ${to}`);
  }

  const remaining = await prisma.location.count();
  console.log(`\nDone. Locations remaining: ${remaining}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
