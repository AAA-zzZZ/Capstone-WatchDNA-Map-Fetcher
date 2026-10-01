/**
 * Backup Location.brands values, then normalize them using normalizeBrandsCsvField
 * (same rules as the scraper ingest pipeline: alias resolution, dedupe, invalid token rejection).
 *
 * Usage:
 *   npm run normalize-brands              # backup + apply updates + log
 *   npm run normalize-brands -- --dry-run # backup + log only (no DB writes)
 *   npm run normalize-brands -- --restore ./backups/location-brands-....json
 *
 * Backups are written under backend/backups/ as location-brands-<ISO-timestamp>.json
 * Only normalizes the plain-text `brands` column.
 * The `customBrands` HTML column is left intact — getBrands() normalizes it at read time.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { normalizeBrandsCsvField } from '../utils/brand-display-name';

interface BrandsBackupRow {
  id: string;
  handle: string;
  name: string;
  brands: string | null;
}

interface BrandsBackupFile {
  exportedAt: string;
  purpose: string;
  note: string;
  rowCount: number;
  locations: BrandsBackupRow[];
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
  const data = JSON.parse(raw) as BrandsBackupFile;
  if (!data.locations?.length) {
    console.error('❌ Invalid backup: missing locations[]');
    process.exit(1);
  }
  console.log(`\n🔙 Restoring ${data.locations.length} rows from ${abs}\n`);
  let restored = 0;
  for (const row of data.locations) {
    await prisma.location.update({
      where: { id: row.id },
      data: { brands: row.brands },
    });
    restored++;
    console.log(`  [RESTORE] ${row.handle}  brands="${row.brands}"`);
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
  const backupPath = path.join(backupsDir, `location-brands-${stamp}.json`);

  console.log('📥 Loading all locations with non-null brands from the database...\n');
  const rows = await prisma.location.findMany({
    where: { brands: { not: null } },
    select: { id: true, handle: true, name: true, brands: true },
    orderBy: { handle: 'asc' },
  });

  const backup: BrandsBackupFile = {
    exportedAt: new Date().toISOString(),
    purpose: 'pre-normalize-brands',
    note: 'Restore with: npm run normalize-brands -- --restore ./backups/<this-file>',
    rowCount: rows.length,
    locations: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      name: r.name,
      brands: r.brands,
    })),
  };

  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2), 'utf-8');
  console.log(`💾 Backup written: ${backupPath}`);
  console.log(`   Rows: ${rows.length}\n`);
  console.log(`${'='.repeat(72)}`);
  console.log(dryRun ? '🔍 DRY RUN — no database updates will be applied' : '✏️  APPLYING normalizations');
  console.log(`${'='.repeat(72)}\n`);

  const changes: { id: string; handle: string; name: string; before: string | null; after: string | null }[] = [];
  const unchanged: string[] = [];

  for (const r of rows) {
    const before = r.brands;
    const after = normalizeBrandsCsvField(before);
    // Treat null → null as unchanged; compare normalized string
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
    console.log('✅ Nothing to update — all brands values are already canonical.');
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
          data: { brands: c.after },
        })
      )
    );
    applied += slice.length;
    console.log(`  … applied batch (${applied}/${changes.length})`);
  }

  console.log(`\n✅ Updated ${changes.length} location(s). Backup saved at:\n   ${backupPath}`);
  console.log('\nTo roll back, run:');
  console.log(`   npm run normalize-brands -- --restore ${path.relative(process.cwd(), backupPath)}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  prisma.$disconnect().finally(() => process.exit(1));
});
