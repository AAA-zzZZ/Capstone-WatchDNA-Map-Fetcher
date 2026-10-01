import type { LocationData } from './csv-to-location';
import { normalizeBrandsCsvField } from './brand-display-name';

type ExistingSnapshot = {
  brands: string | null;
  customBrands: string | null;
  phone: string | null;
};

/**
 * Union comma-separated brand labels (case-insensitive dedupe, preserve first-seen casing).
 */
export function mergeCommaSeparatedBrands(a: string | null, b: string | null): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | null) => {
    for (const part of (raw ?? '').split(',')) {
      const t = part.trim();
      if (!t) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
  };
  add(a);
  add(b);
  return out.length ? out.join(', ') : null;
}

/**
 * Brand display names from `customBrands` (comma-separated and/or &lt;a&gt;…&lt;/a&gt; chunks), no normalization.
 */
export function brandNamesFromCustomBrandsField(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  const fromAnchors: string[] = [];
  const re = /<a[^>]*>([^<]*)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const t = m[1]?.trim();
    if (t) fromAnchors.push(t);
  }
  if (fromAnchors.length) return fromAnchors;
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function brandKeysFromNormalizedBrandsCsv(csv: string | null): Set<string> {
  const n = normalizeBrandsCsvField(csv);
  if (!n) return new Set();
  return new Set(n.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
}

/**
 * One canonical `brands` CSV from both columns on existing + incoming (scraper) rows so manually added
 * names in `customBrands` are recognized and not duplicated when the scrape adds the same brand to `Brands`.
 */
export function unifiedBrandsAfterMerge(
  existingBrands: string | null,
  existingCustom: string | null,
  incomingBrands: string | null,
  incomingCustom: string | null
): string | null {
  const tokens: string[] = [];
  const pushFromBrandsCsv = (csv: string | null) => {
    const n = normalizeBrandsCsvField(csv);
    if (!n) return;
    for (const t of n.split(',')) {
      const x = t.trim();
      if (x) tokens.push(x);
    }
  };
  const pushFromCustom = (c: string | null) => {
    if (!c?.trim()) return;
    for (const raw of brandNamesFromCustomBrandsField(c)) {
      const n = normalizeBrandsCsvField(raw);
      if (n) tokens.push(n);
    }
  };

  pushFromBrandsCsv(existingBrands);
  pushFromBrandsCsv(incomingBrands);
  pushFromCustom(existingCustom);
  pushFromCustom(incomingCustom);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length ? out.join(', ') : null;
}

function mergeCustomBrandsTopLevelSegments(a: string | null, b: string | null): string | null {
  const parts = [a, b].map((x) => (x ?? '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/**
 * Drops comma-separated custom segments whose brand names are all already represented in `brandsCsv`
 * (after normalization), so scrapes do not leave redundant copies in `customBrands`.
 */
export function stripCustomBrandsRedundantWithBrandsColumn(
  custom: string | null,
  brandsCsv: string | null
): string | null {
  if (!custom?.trim()) return null;
  const keys = brandKeysFromNormalizedBrandsCsv(brandsCsv);
  if (keys.size === 0) return custom.trim() || null;

  const segments = custom
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const seg of segments) {
    const nameList = brandNamesFromCustomBrandsField(seg);
    if (nameList.length === 0) {
      kept.push(seg);
      continue;
    }
    const allInBrands = nameList.every((raw) => {
      const d = normalizeBrandsCsvField(raw);
      if (!d) return true;
      return keys.has(d.toLowerCase());
    });
    if (!allInBrands) kept.push(seg);
  }
  return kept.length ? kept.join(', ') : null;
}

/**
 * Merge incoming scrape/job row into an existing Location.
 * Brand names are unioned across `brands` and `customBrands` on both sides (normalized, deduped) so
 * manually added brands are picked up without duplicating when a future scrape adds the same label.
 * Phone always stays the DB value — scrapes do not change it.
 */
export function mergeLocationDataForUpdate(
  existing: ExistingSnapshot,
  incoming: LocationData
): LocationData {
  const brands = unifiedBrandsAfterMerge(
    existing.brands,
    existing.customBrands,
    incoming.brands,
    incoming.customBrands
  );
  const mergedCustom = mergeCustomBrandsTopLevelSegments(existing.customBrands, incoming.customBrands);
  const customBrands = stripCustomBrandsRedundantWithBrandsColumn(mergedCustom, brands);

  return {
    ...incoming,
    brands,
    customBrands,
    phone: existing.phone,
  };
}

/**
 * Admin CSV import into an existing Location: union brands like scraper saves, but allow
 * the spreadsheet to correct phone when the cell is non-empty (validated imports require phone).
 */
export function mergeLocationDataForManualImport(
  existing: ExistingSnapshot,
  incoming: LocationData
): LocationData {
  const merged = mergeLocationDataForUpdate(existing, incoming);
  const incomingPhone = (incoming.phone ?? '').trim();
  return {
    ...merged,
    phone: incomingPhone ? incoming.phone : existing.phone,
  };
}
