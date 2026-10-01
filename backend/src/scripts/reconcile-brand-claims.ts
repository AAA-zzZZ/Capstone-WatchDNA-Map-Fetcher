/**
 * Reconcile one brand's claims against its own store-locator feed.
 *
 * A brand's scraped feed is the authoritative list of stores carrying that brand. Historical
 * name-blind merges unioned brands onto the wrong survivors (e.g. a whole mall's watch
 * retailers collapsed into "Maggie's Diamond Boutique" holding 14 brands), and imports only
 * ever ADD brands — nothing subtracts a stale claim. This script does the subtraction:
 *
 *   1. Match every row of the given scrape CSV to existing Location rows using the exact
 *      import-time identity rules (stable handle, name-scoped handle, fuzzy matchers).
 *   2. Every Location still listing the brand that the feed did NOT account for is stale —
 *      remove that one brand token from its Brands column.
 *
 * Only the scraper-managed `brands` column is touched. `customBrands` (admin-curated),
 * premium flags, and StorePremiumBrand rows are never modified.
 *
 * ALWAYS reconcile against a fresh, verified-good scrape: a partial/blocked scrape would
 * mark healthy stores stale. Guards below abort on small feeds or implausible removal
 * ratios unless --force is passed.
 *
 * Usage:
 *   npx ts-node src/scripts/reconcile-brand-claims.ts --brand rolex_stores --csv uploads/scraped/rolex_stores_<ts>.csv
 *   npx ts-node src/scripts/reconcile-brand-claims.ts --brand "TAG HEUER" --csv <path> --execute
 *
 * Options:
 *   --brand <id|name>     Brand config id or display name (required)
 *   --csv <path>          Scrape CSV for that brand (required)
 *   --execute             Apply changes (default: dry-run report)
 *   --force               Skip the small-feed / high-removal-ratio safety guards
 *   --min-feed-rows <n>   Abort below this many parseable feed rows (default 10)
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import prisma from '../lib/prisma';
import { storeService } from '../services/store.service';
import { brandConfigIdToDisplayName } from '../utils/brand-display-name';
import { reconcileBrandClaims } from '../utils/brand-claims-reconcile';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const execute = process.argv.includes('--execute');
const force = process.argv.includes('--force');
const brandArg = argValue('--brand');
const csvArg = argValue('--csv');
const minFeedRows = parseInt(argValue('--min-feed-rows') ?? '10', 10);

function fail(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  if (!brandArg || !csvArg) {
    fail('both --brand and --csv are required (see usage in the file header)');
  }
  const brandDisplay = brandConfigIdToDisplayName(brandArg);
  if (!brandDisplay) fail(`could not derive a display name from --brand "${brandArg}"`);

  const csvPath = path.resolve(csvArg);
  if (!fs.existsSync(csvPath)) fail(`CSV not found: ${csvPath}`);

  console.log(execute ? 'MODE: EXECUTE (writes to DB)\n' : 'MODE: DRY-RUN (no writes)\n');
  console.log(`Brand: ${brandDisplay}  (from --brand "${brandArg}")`);
  console.log(`Feed:  ${csvPath}`);

  const parsedCsv = Papa.parse(fs.readFileSync(csvPath, 'utf8'), {
    header: true,
    skipEmptyLines: true,
  });
  const feedRows = (parsedCsv.data as Record<string, string>[]).filter(
    (r) => Object.values(r).some((v) => String(v ?? '').trim() !== '')
  );
  console.log(`Feed rows: ${feedRows.length}`);

  // Sanity: the CSV should be this brand's feed. Its Brands column normally names the brand.
  const rowsNamingBrand = feedRows.filter((r) =>
    String(r.Brands ?? '')
      .split(',')
      .some((t) => brandConfigIdToDisplayName(t).toLowerCase() === brandDisplay.toLowerCase())
  ).length;
  if (rowsNamingBrand === 0) {
    const msg = `no feed row's Brands column names "${brandDisplay}" — is this the right CSV for the brand?`;
    if (!force) fail(`${msg} (pass --force to override)`);
    console.warn(`WARNING: ${msg}`);
  }

  if (feedRows.length < minFeedRows && !force) {
    fail(
      `feed has only ${feedRows.length} rows (< ${minFeedRows}) — looks like a partial scrape. ` +
        'Re-scrape or pass --force / --min-feed-rows.'
    );
  }

  console.log('\nMatching feed rows to existing locations (same matchers as import)…');
  const { matchedHandles, parsedRows, skippedRows } =
    await storeService.matchRecordsToExistingLocations(feedRows);
  console.log(`Parseable feed rows: ${parsedRows} (skipped ${skippedRows})`);
  console.log(`Existing locations accounted for by the feed: ${matchedHandles.size}`);

  const report = await reconcileBrandClaims({
    brand: brandDisplay,
    matchedHandles,
    feedRows: feedRows.length,
    execute,
    force,
    minFeedRows,
  });

  console.log(`\nLocations claiming ${report.brand}: ${report.claimants}`);
  console.log(`  confirmed by feed: ${report.confirmed}`);
  console.log(`  stale (feed does not account for them): ${report.stale.length}`);

  for (const s of report.stale) {
    console.log(
      `\n${s.handle} | ${s.name} | ${s.city}, ${s.country}` +
        `\n  brands: ${s.brandsBefore}` +
        `\n  after:  ${s.brandsAfter ?? '(none)'}`
    );
  }

  if (report.guard) {
    fail(`${report.guard} (pass --force to override)`);
  }
  if (!execute) {
    console.log(`\nDry-run complete. Pass --execute to remove ${report.brand} from the ${report.stale.length} stale rows.`);
    return;
  }
  console.log(
    report.applied
      ? `\nDone. Removed ${report.brand} from ${report.stale.length} locations. customBrands/premium data untouched.`
      : `\nNothing to remove — every claimant is confirmed by the feed.`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
