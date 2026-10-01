/**
 * Subtract stale brand claims after a brand's feed has been imported.
 *
 * A brand's own store-locator feed is authoritative for that brand. Imports only ever ADD
 * brands (merges union them), so claims left behind by historical bad merges — e.g. a whole
 * mall's retailers collapsed onto one survivor — persist forever unless subtracted. Given the
 * set of Location handles a feed accounted for, this module finds every other location still
 * claiming the brand and (optionally) removes that one brand token.
 *
 * Only the scraper-managed `brands` column is ever touched. `customBrands` (admin-curated),
 * premium flags, and StorePremiumBrand rows are never modified.
 *
 * Safety guards (skipped with `force`) keep a partial or broken scrape from mass-stripping
 * healthy stores: small feeds, feeds confirming zero current claimants, and implausibly high
 * removal ratios all block the apply step (the report is still produced).
 */

import prisma from '../lib/prisma';
import { brandConfigIdToDisplayName, removeBrandFromCsvField } from './brand-display-name';
import { logger } from './logger';

export const RECONCILE_MIN_FEED_ROWS = 10;
export const RECONCILE_MAX_REMOVAL_RATIO = 0.8;

export type StaleBrandClaim = {
  handle: string;
  name: string;
  city: string;
  country: string;
  brandsBefore: string;
  brandsAfter: string | null;
};

export type BrandReconcileReport = {
  /** Canonical display name of the reconciled brand. */
  brand: string;
  feedRows: number;
  /** Locations currently listing the brand. */
  claimants: number;
  /** Claimants the feed accounted for. */
  confirmed: number;
  stale: StaleBrandClaim[];
  /** True when the stale claims were actually removed from the DB. */
  applied: boolean;
  /** Reason the apply step was blocked (guards) or skipped (report-only mode). */
  guard?: string;
};

export async function reconcileBrandClaims(opts: {
  /** Brand config id or display name. */
  brand: string;
  /** Handles the feed accounted for (e.g. UpsertResult.affectedHandles or the CLI matcher). */
  matchedHandles: Set<string>;
  feedRows: number;
  /** Apply removals; false produces a report only. */
  execute: boolean;
  /** Skip all safety guards (CLI --force). */
  force?: boolean;
  minFeedRows?: number;
  maxRemovalRatio?: number;
}): Promise<BrandReconcileReport> {
  const brand = brandConfigIdToDisplayName(opts.brand);
  if (!brand) throw new Error(`cannot derive a brand display name from "${opts.brand}"`);
  const minFeedRows = opts.minFeedRows ?? RECONCILE_MIN_FEED_ROWS;
  const maxRemovalRatio = opts.maxRemovalRatio ?? RECONCILE_MAX_REMOVAL_RATIO;

  // `contains` narrows in SQL; the exact token check happens in JS via display-name
  // normalization so stored variants ("BALL WATCH" vs "BALL") count and substrings don't.
  const brandLower = brand.toLowerCase();
  const claimantRows = (
    await prisma.location.findMany({
      where: { brands: { contains: brand.split(' ')[0], mode: 'insensitive' } },
      select: { handle: true, name: true, brands: true, city: true, country: true },
      orderBy: { handle: 'asc' },
    })
  ).filter((l) =>
    String(l.brands ?? '')
      .split(',')
      .some((t) => brandConfigIdToDisplayName(t).toLowerCase() === brandLower)
  );

  const stale: StaleBrandClaim[] = claimantRows
    .filter((l) => !opts.matchedHandles.has(l.handle))
    .map((l) => ({
      handle: l.handle,
      name: l.name,
      city: l.city,
      country: l.country,
      brandsBefore: l.brands ?? '',
      brandsAfter: removeBrandFromCsvField(l.brands, brand),
    }));

  const report: BrandReconcileReport = {
    brand,
    feedRows: opts.feedRows,
    claimants: claimantRows.length,
    confirmed: claimantRows.length - stale.length,
    stale,
    applied: false,
  };

  if (!opts.force) {
    if (opts.feedRows < minFeedRows) {
      report.guard = `feed has only ${opts.feedRows} rows (< ${minFeedRows}) — looks like a partial scrape`;
    } else if (report.claimants > 0 && report.confirmed === 0 && stale.length > 0) {
      report.guard = 'feed confirmed none of the current claimants — bad/mismatched feed far more likely than 100% stale data';
    } else if (report.claimants >= 10 && stale.length / report.claimants > maxRemovalRatio) {
      report.guard = `${stale.length}/${report.claimants} claimants would lose the brand (> ${Math.round(maxRemovalRatio * 100)}%) — suspicious for a healthy feed`;
    }
  }

  if (!opts.execute || report.guard || stale.length === 0) return report;

  for (const s of stale) {
    await prisma.location.update({
      where: { handle: s.handle },
      data: { brands: s.brandsAfter },
    });
  }
  report.applied = true;
  logger.info(
    `[brand-reconcile] Removed stale ${brand} claim from ${stale.length} location(s) ` +
      `(${report.confirmed}/${report.claimants} confirmed by feed)`
  );
  return report;
}

/** Job-log block for scraper pipelines. */
export function formatBrandReconcileLog(r: BrandReconcileReport): string {
  const lines = [
    `\n\n=== BRAND CLAIM RECONCILE (${r.brand}) ===`,
    `Claimants: ${r.claimants} | confirmed by feed: ${r.confirmed} | stale: ${r.stale.length}`,
  ];
  if (r.guard) lines.push(`Guard blocked apply: ${r.guard}`);
  for (const s of r.stale.slice(0, 25)) {
    lines.push(`  ${s.handle} | ${s.name} | ${s.city}, ${s.country}`);
  }
  if (r.stale.length > 25) lines.push(`  … and ${r.stale.length - 25} more`);
  if (r.stale.length > 0) {
    lines.push(
      r.applied
        ? `Removed ${r.brand} from the ${r.stale.length} location(s) above.`
        : `Report only — no changes applied. Run reconcile-brand-claims --execute (or set SCRAPER_RECONCILE_EXECUTE=true) to apply.`
    );
  }
  return lines.join('\n');
}
