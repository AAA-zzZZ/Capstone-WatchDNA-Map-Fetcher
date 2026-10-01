/**
 * ONE-TIME MIGRATION / DISASTER RECOVERY TOOL
 *
 * This script is NOT part of the normal scraper pipeline. Under normal operation
 * the DB is kept in sync automatically:
 *   - Each completed scrape job upserts its records directly into the Location table.
 *   - Admin edits and saveJobRecords also write directly to the DB.
 *
 * Run this script ONLY when you need to:
 *   a) Bootstrap a fresh database from a CSV export (admin download or GET /backend/uploads/master_stores.csv).
 *   b) Recover from a catastrophic DB loss using a known-good export.
 *
 * Set MASTER_IMPORT_CSV to an absolute path, or place the export at backend/uploads/master_stores.csv
 * (that path is not committed; the DB is the source of truth).
 *
 * WARNING: This performs a full TRUNCATE of the Location table before inserting.
 * All rows currently in the DB will be permanently deleted.
 *
 * Usage: npm run import-master
 */

import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import prisma from '../lib/prisma';
import { storeService } from '../services/store.service';

function resolveMasterImportPath(): string {
  const fromEnv = process.env.MASTER_IMPORT_CSV?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, '..', '..', 'uploads', 'master_stores.csv');
}

async function importMasterCSV() {
  console.log('Starting master CSV import...\n');

  const CSV_PATH = resolveMasterImportPath();
  if (!fs.existsSync(CSV_PATH)) {
    throw new Error(
      `CSV not found at: ${CSV_PATH}\n` +
        'Export from the running API (e.g. GET /backend/uploads/master_stores.csv) or set MASTER_IMPORT_CSV to your export file path.'
    );
  }

  const fileContent = fs.readFileSync(CSV_PATH, 'utf-8');
  const { data: rawRows, errors } = Papa.parse(fileContent, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim()
  });

  if (errors.length > 0) {
    console.warn(`CSV parse warnings: ${errors.length}`);
  }

  const rows = rawRows as Record<string, string>[];
  console.log(`Parsed ${rows.length} rows from CSV`);

  console.log('Clearing existing Location rows...');
  const { count: deleted } = await prisma.location.deleteMany({});
  console.log(`Deleted ${deleted} existing rows`);

  // Route through the full pipeline so within-batch collapse and cross-batch DB-side dedup
  // both run — the same path as a CSV upload from the admin panel.
  console.log(`Importing ${rows.length} rows through dedup pipeline...`);
  const result = await storeService.batchUpsertLocations(rows, undefined, {
    failFast: false,
    requireCompleteForDb: true,
    mergeOnUpdate: true,
    mergeKind: 'scraper',
  });

  console.log(`\nImport result:`);
  console.log(`  Created:   ${result.created}`);
  console.log(`  Updated:   ${result.updated}`);
  console.log(`  Unchanged: ${result.unchanged}`);
  console.log(`  Skipped (incomplete): ${result.skippedIncomplete ?? 0}`);
  if (result.failed) console.log(`  Failed:    ${result.failed}`);

  console.log('\nRe-applying premium flags from PremiumStore table...');
  const premiumCount = await prisma.premiumStore.count();

  if (premiumCount > 0) {
    await prisma.$executeRaw`
      UPDATE "Location" l
      SET
        "isVerifiedDealer" = ps."isVerifiedDealer",
        "isBoutique" = ps."isBoutique",
        "isServiceCenter" = ps."isServiceCenter",
        "isPremium" = (ps."isVerifiedDealer" OR ps."isBoutique" OR ps."isServiceCenter")
      FROM "PremiumStore" ps
      WHERE l.handle = ps.handle
    `;
    console.log(`Applied premium flags (${premiumCount} premium handles on record)`);
  } else {
    console.log('No premium stores on record — skipping premium flag update');
  }

  const finalCount = await prisma.location.count();
  console.log(`\nImport complete: ${finalCount} locations in database`);
}

importMasterCSV()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Import failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
