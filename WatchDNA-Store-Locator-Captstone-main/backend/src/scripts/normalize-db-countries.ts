/**
 * Backup Location.country values, then normalize them to canonical full English names
 * (same rules as csv-to-location / country.ts).
 *
 * Usage:
 *   npm run normalize-countries              # backup + apply updates + log
 *   npm run normalize-countries -- --dry-run # backup + log only (no DB writes)
 *   npm run normalize-countries -- --restore ./backups/location-countries-....json
 *
 * Backups are written under backend/backups/ as location-countries-<ISO-timestamp>.json
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { normalizeCountry } from '../utils/country';

interface CountryBackupRow {
  id: string;
  handle: string;
  name: string;
  country: string;
}

interface CountryBackupFile {
  exportedAt: string;
  purpose: string;
  note: string;
  rowCount: number;
  locations: CountryBackupRow[];
}

function parseArgs(): { dryRun: boolean; restorePath: string | null } {
  const args = process.argv.slice(2);
  let dryRun = false;
  let restorePath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') dryRun = true;
    if (args[i] === '--restore' && args[i + 1]) {
      restorePath = args[++i];
    }
  }
  return { dryRun, restorePath };
}

async function restoreFromBackup(filePath: string): Promise<void> {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    console.error(`❌ Backup file not found: ${abs}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, 'utf-8');
  const data = JSON.parse(raw) as CountryBackupFile;
  if (!data.locations?.length) {
    console.error('❌ Invalid backup: missing locations[]');
    process.exit(1);
  }
  console.log(`\n🔙 Restoring ${data.locations.length} rows from ${abs}\n`);
  let restored = 0;
  for (const row of data.locations) {
    await prisma.location.update({
      where: { id: row.id },
      data: { country: row.country },
    });
    restored++;
    console.log(`  [RESTORE] ${row.handle}  country="${row.country}"`);
  }
  console.log(`\n✅ Restored ${restored} location(s).`);
}

async function main(): Promise<void> {
  const { dryRun, restorePath } = parseArgs();

  if (restorePath) {
    await restoreFromBackup(restorePath);
    await prisma.$disconnect();
    process.exit(0);
    return;
  }

  const backupsDir = path.join(__dirname, '..', '..', 'backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `location-countries-${stamp}.json`);

  console.log('📥 Loading all locations from the database...\n');
  const rows = await prisma.location.findMany({
    select: { id: true, handle: true, name: true, country: true },
    orderBy: { handle: 'asc' },
  });

  const backup: CountryBackupFile = {
    exportedAt: new Date().toISOString(),
    purpose: 'pre-normalize-countries',
    note: 'Restore with: npm run normalize-countries -- --restore ./backups/<this-file>',
    rowCount: rows.length,
    locations: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      name: r.name,
      country: r.country,
    })),
  };

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf-8');
  console.log(`💾 Backup written: ${backupPath}`);
  console.log(`   Rows: ${rows.length}\n`);
  console.log(`${'='.repeat(72)}`);
  console.log(dryRun ? '🔍 DRY RUN — no database updates will be applied' : '✏️  APPLYING normalizations');
  console.log(`${'='.repeat(72)}\n`);

  const changes: { id: string; handle: string; name: string; before: string; after: string }[] = [];
  const unchanged: string[] = [];

  for (const r of rows) {
    const before = r.country;
    const after = normalizeCountry(before);
    if (after !== before) {
      changes.push({ id: r.id, handle: r.handle, name: r.name, before, after });
      console.log(`  [UPDATE] handle=${r.handle}`);
      console.log(`           name:   ${r.name}`);
      console.log(`           before: "${before}"`);
      console.log(`           after:  "${after}"`);
      console.log('');
    } else {
      unchanged.push(r.handle);
    }
  }

  console.log(`${'='.repeat(72)}`);
  console.log(`Summary: ${changes.length} row(s) need updating, ${unchanged.length} unchanged`);
  console.log(`${'='.repeat(72)}\n`);

  if (changes.length === 0) {
    console.log('✅ Nothing to update — all country values are already canonical.');
    await prisma.$disconnect();
    process.exit(0);
    return;
  }

  if (dryRun) {
    console.log('🔍 Dry run complete. Re-run without --dry-run to apply changes.');
    await prisma.$disconnect();
    process.exit(0);
    return;
  }

  const BATCH = 50;
  let applied = 0;
  for (let i = 0; i < changes.length; i += BATCH) {
    const slice = changes.slice(i, i + BATCH);
    await prisma.$transaction(
      slice.map((c) =>
        prisma.location.update({
          where: { id: c.id },
          data: { country: c.after },
        })
      )
    );
    applied += slice.length;
    console.log(`  … applied batch (${applied}/${changes.length})`);
  }

  console.log(`\n✅ Updated ${changes.length} location(s). Backup saved at:\n   ${backupPath}`);
  console.log('\nTo roll back, run:');
  console.log(`   npm run normalize-countries -- --restore ${path.relative(process.cwd(), backupPath)}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
