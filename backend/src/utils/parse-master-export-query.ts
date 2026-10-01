import type { Request } from 'express';

import type { MasterExportFilters } from './master-export-filters';

function firstQueryString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return '';
}

/** Read optional `brand`, `country`, `premium` from Express query (same for scraper + upload routes). */
export function masterExportFiltersFromQuery(req: Request): MasterExportFilters | undefined {
  const brand = firstQueryString(req.query.brand).trim();
  const country = firstQueryString(req.query.country).trim();
  const premiumStr = firstQueryString(req.query.premium).toLowerCase();
  const premiumOnly = ['1', 'true', 'yes'].includes(premiumStr);
  if (!brand && !country && !premiumOnly) return undefined;
  return {
    ...(brand ? { brand } : {}),
    ...(country ? { country } : {}),
    ...(premiumOnly ? { premiumOnly: true } : {}),
  };
}

/**
 * Same `brand` / `premium` parsing as master export, but ignores `country`.
 * Use when the query must not be narrowed by a country filter (e.g. distinct country list for a dropdown).
 */
export function masterBrandPremiumScopeFromQuery(req: Request):
  | { brand?: string; premiumOnly?: boolean }
  | undefined {
  const brand = firstQueryString(req.query.brand).trim();
  const premiumStr = firstQueryString(req.query.premium).toLowerCase();
  const premiumOnly = ['1', 'true', 'yes'].includes(premiumStr);
  if (!brand && !premiumOnly) return undefined;
  return {
    ...(brand ? { brand } : {}),
    ...(premiumOnly ? { premiumOnly: true } : {}),
  };
}
