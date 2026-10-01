/**
 * Shared post-import deduplication logic.
 *
 * This module is the single source of truth for merge-plan building and execution
 * across every dedup surface in the system.  It is intentionally free of brand-
 * specific or pipeline-specific concerns — callers filter the input rows they pass in.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * CONFIDENCE TIERS
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Tier A — import-time (store.service.ts > tripletAllowsMerge)
 *   Conservative: all three signals (name + address + coordinates within 300 m)
 *   must agree.  Runs automatically on every scrape / CSV upload.
 *   Best for: preventing new duplicates from being written in the first place.
 *
 * Tier B — post-import, brand-scoped (geo-verify-pipeline.service.ts)
 *   Runs after coordinates have been re-geocoded so bad pins no longer block
 *   merges.  Uses address-fingerprint equality (same building, different "St" vs
 *   "Street") AND geo-proximity (≤ GEO_PROXIMITY_M) with name-similarity and
 *   shared-street-number guards.  Brand-scoped so a single brand's stores are
 *   compared against each other only.
 *   Best for: cleaning up accumulated duplicates after a geocoding run.
 *
 * Tier C — post-import, global CLI (merge-address-duplicate-locations.ts)
 *   Same two-pass logic as Tier B but applied across ALL stores regardless of
 *   brand.  Higher blast radius — always do a dry-run first and review the output
 *   before passing --execute.
 *   Best for: one-off global cleanup; not intended as a routine automated step.
 *
 * Plan builders in this module implement Tier B / C logic.  Tier A stays in
 * store.service.ts because it operates at row-level during upsert, not on a full
 * snapshot of the DB.
 */

import prisma from '../lib/prisma';
import { dedupeAddressFingerprint } from './address-dedupe';
import { normalizeBrandsCsvField } from './brand-display-name';
import { normalizeCountry } from './country';
import {
  boundingBoxForRadiusMeters,
  haversineDistanceMeters,
  isUnusableScraperCoordinate,
  namesClearlyDistinct,
  namesSimilarForDedupe,
} from './geo-dedupe';
import { mergeCommaSeparatedBrands } from './merge-location-update';
import { logger } from './logger';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Tight geo-proximity radius for Tier B / C merging.
 * 150 m captures same-building variants (different geocode precision, suite number
 * missing) while stopping well short of two distinct stores on the same block.
 */
export const GEO_PROXIMITY_M = 150;

/**
 * Maximum coordinate spread allowed within an address-fingerprint group.
 * Groups whose members span more than this are likely address-collision false
 * positives (different cities sharing a street name) and are left unmerged.
 */
export const MAX_GROUP_SPREAD_M = 500;

/** Minimum address fingerprint length to use for grouping (avoids matching on empty strings). */
export const MIN_ADDRESS_FP_LEN = 6;

/**
 * If scoped expansion pulls more than this many distinct handles, fall back to a global
 * dedupe pass so we never skip merges due to an oversized neighborhood (dense city + huge batch).
 */
const MAX_SCOPED_CANDIDATE_HANDLES = 25_000;

/** Max rounds of fingerprint + geo expansion (each round can grow the peer set). */
const SCOPED_EXPAND_ROUNDS = 6;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal shape required by the dedup plan builders. */
export type MergeStoreRow = {
  handle: string;
  name: string;
  brands: string | null;
  customBrands: string | null;
  tags: string | null;
  addressLine1: string;
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  isPremium: boolean;
  updatedAt: Date;
};

export type MergePlan = {
  keep: MergeStoreRow;
  remove: MergeStoreRow[];
  mergedBrands: string | null;
  mergedCustomBrands: string | null;
  mergedTags: string | null;
  mergedName: string;
  /** How this group was identified — dedupe tier or admin manual merge. */
  label: 'address-fingerprint' | 'geo-proximity' | 'manual';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fingerprintGroupKey(loc: { addressLine1: string; city: string; country: string }): string {
  return `${dedupeAddressFingerprint(loc.addressLine1)}|${loc.city.trim().toLowerCase()}|${normalizeCountry(loc.country)}`;
}

/**
 * Extract multi-digit street numbers (≥2 digits) to distinguish different addresses.
 * Single digits are excluded — they tend to be unit or floor numbers.
 */
export function extractStreetNumbers(addr: string): Set<string> {
  const matches = addr.match(/\b\d{2,}\b/g);
  return new Set(matches ?? []);
}

/**
 * True when both address strings share at least one street number, or when one (or
 * both) carries no multi-digit number (cannot distinguish, so allow the merge).
 * Prevents "1600 Water St" from merging with "5001 Expressway".
 */
export function addressesShareStreetNumber(addrA: string, addrB: string): boolean {
  const numsA = extractStreetNumbers(addrA);
  const numsB = extractStreetNumbers(addrB);
  if (numsA.size === 0 || numsB.size === 0) return true;
  for (const n of numsA) if (numsB.has(n)) return true;
  return false;
}

function brandFieldCount(s: string | null): number {
  return (s ?? '').split(',').filter((x) => x.trim()).length;
}

/**
 * Comparator that puts the "best" survivor first: premium > most brands > longest
 * name > most recently updated > handle lexicographic order.
 */
export function sortSurvivorFirst(a: MergeStoreRow, b: MergeStoreRow): number {
  if (a.isPremium !== b.isPremium) return a.isPremium ? -1 : 1;
  const ba = brandFieldCount(a.brands) + brandFieldCount(a.customBrands);
  const bb = brandFieldCount(b.brands) + brandFieldCount(b.customBrands);
  if (ba !== bb) return bb - ba;
  const na = (a.name ?? '').trim().length;
  const nb = (b.name ?? '').trim().length;
  if (na !== nb) return nb - na;
  const t = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (t !== 0) return t;
  return a.handle.localeCompare(b.handle);
}

/**
 * Build a single merge plan from a group of rows that have already been determined
 * to represent the same physical store.  Brands, customBrands, and tags are unioned
 * so no affiliation is silently dropped.  The longest name is kept.
 */
export function buildMergePlanFromGroup(
  members: MergeStoreRow[],
  label: MergePlan['label']
): MergePlan {
  const sorted = [...members].sort(sortSurvivorFirst);
  const keep = sorted[0]!;
  const remove = sorted.slice(1);
  let brands = normalizeBrandsCsvField(keep.brands);
  let customBrands = keep.customBrands ?? null;
  let tags = keep.tags ?? null;
  let mergedName = (keep.name ?? '').trim();
  for (const r of remove) {
    brands = mergeCommaSeparatedBrands(brands, normalizeBrandsCsvField(r.brands));
    customBrands = mergeCommaSeparatedBrands(customBrands, r.customBrands);
    tags = mergeCommaSeparatedBrands(tags, r.tags);
    const rn = (r.name ?? '').trim();
    if (rn.length > mergedName.length) mergedName = rn;
  }
  return { keep, remove, mergedBrands: brands, mergedCustomBrands: customBrands, mergedTags: tags, mergedName, label };
}

/**
 * Admin manual merge: fixed survivor row; union brands/customBrands/tags and longest name
 * like {@link buildMergePlanFromGroup}. Caller applies `mergedStore` from the UI for
 * address/contact/coords; brand columns should come from this plan only.
 */
export function buildManualMergePlan(survivor: MergeStoreRow, others: MergeStoreRow[]): MergePlan {
  const remove = [...others].sort((a, b) => a.handle.localeCompare(b.handle));
  const keep = survivor;
  let brands = normalizeBrandsCsvField(keep.brands);
  let customBrands = keep.customBrands ?? null;
  let tags = keep.tags ?? null;
  let mergedName = (keep.name ?? '').trim();
  for (const r of remove) {
    brands = mergeCommaSeparatedBrands(brands, normalizeBrandsCsvField(r.brands));
    customBrands = mergeCommaSeparatedBrands(customBrands, r.customBrands);
    tags = mergeCommaSeparatedBrands(tags, r.tags);
    const rn = (r.name ?? '').trim();
    if (rn.length > mergedName.length) mergedName = rn;
  }
  return {
    keep,
    remove,
    mergedBrands: brands,
    mergedCustomBrands: customBrands,
    mergedTags: tags,
    mergedName,
    label: 'manual',
  };
}

// ─── Plan builders ────────────────────────────────────────────────────────────

/**
 * Split a same-address group into clusters whose members may name the same store.
 * Two boutiques legitimately sharing one building ("Omega Boutique", "IWC Boutique") land in
 * separate clusters and are never merged; name variants and blank names stay together.
 * Two premium-program stores are always kept apart — admins curate those records, and
 * mall boutique families ("LA MAISON MONACO | IWC / TAG HEUER BOUTIQUE …") share enough
 * name tokens to look similar while being distinct listings.
 */
function clusterGroupByName(members: MergeStoreRow[]): MergeStoreRow[][] {
  const n = members.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]!);
    return parent[i]!;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (members[i]!.isPremium && members[j]!.isPremium) continue;
      if (namesClearlyDistinct(members[i]!.name, members[j]!.name)) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
    }
  }
  const byRoot = new Map<number, MergeStoreRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(members[i]!);
  }
  return [...byRoot.values()];
}

/**
 * Build merge plans for the given stores using two passes:
 *
 * Pass 1 (address-fingerprint): same deduped fp + city + country.
 *   Catches "St" vs "Street", extra spaces, minor abbreviations.
 *   Groups are split by name similarity first — clearly different-named boutiques at one
 *   address stay separate. Coordinate spread ≤ MAX_GROUP_SPREAD_M is checked per cluster to
 *   avoid merging unrelated locations that happen to share an address string.
 *
 * Pass 2 (geo-proximity): different fp, same country, ≤ GEO_PROXIMITY_M,
 *   similar name, and shared street number.  Catches transliterations, minor
 *   pin offset after a geocoding run.
 *
 * Pass 1 results are excluded from Pass 2 to avoid double-counting.
 *
 * Callers can pre-filter `stores` for brand-scoping (Tier B) or pass the full
 * table for a global run (Tier C).
 */
export function buildDedupPlans(stores: MergeStoreRow[]): MergePlan[] {
  const plans: MergePlan[] = [];
  const alreadyGrouped = new Set<string>();

  // Pass 1: address fingerprint groups
  const byKey = new Map<string, MergeStoreRow[]>();
  for (const loc of stores) {
    const fp = dedupeAddressFingerprint(loc.addressLine1);
    if (fp.length < MIN_ADDRESS_FP_LEN) continue;
    const k = fingerprintGroupKey(loc);
    const list = byKey.get(k) ?? [];
    list.push(loc);
    byKey.set(k, list);
  }
  for (const members of byKey.values()) {
    if (members.length < 2) continue;

    for (const cluster of clusterGroupByName(members)) {
      if (cluster.length < 2) continue;

      // Only skip clusters that are geographically implausible (bad geocodes pushing
      // members far apart).  Same-address clusters with one unusable coord are fine.
      const usable = cluster.filter((m) => !isUnusableScraperCoordinate(m.latitude, m.longitude));
      if (usable.length >= 2) {
        let maxD = 0;
        for (let i = 0; i < usable.length; i++) {
          for (let j = i + 1; j < usable.length; j++) {
            maxD = Math.max(
              maxD,
              haversineDistanceMeters(usable[i]!.latitude, usable[i]!.longitude, usable[j]!.latitude, usable[j]!.longitude)
            );
          }
        }
        if (maxD > MAX_GROUP_SPREAD_M) continue;
      }

      plans.push(buildMergePlanFromGroup(cluster, 'address-fingerprint'));
      for (const m of cluster) alreadyGrouped.add(m.handle);
    }
  }

  // Pass 2: geo-proximity groups (different address fingerprint, same country, ≤ GEO_PROXIMITY_M)
  const candidates = stores.filter(
    (loc) => !alreadyGrouped.has(loc.handle) && !isUnusableScraperCoordinate(loc.latitude, loc.longitude)
  );
  const n = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  const find = (i: number): number => {
    if (parent[i] !== i) parent[i] = find(parent[i]!);
    return parent[i]!;
  };
  const union = (i: number, j: number) => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (a.isPremium && b.isPremium) continue; // curated program records never auto-merge
      if (normalizeCountry(a.country) !== normalizeCountry(b.country)) continue;
      const dist = haversineDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
      if (dist > GEO_PROXIMITY_M) continue;
      if (dedupeAddressFingerprint(a.addressLine1) === dedupeAddressFingerprint(b.addressLine1)) continue;
      if (!namesSimilarForDedupe(a.name, b.name)) continue;
      if (!addressesShareStreetNumber(a.addressLine1, b.addressLine1)) continue;
      union(i, j);
    }
  }

  const byRoot = new Map<number, MergeStoreRow[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r)!.push(candidates[i]!);
  }

  for (const members of byRoot.values()) {
    if (members.length < 2) continue;

    // Spread check — geo-proximity groups whose members are too far apart are likely
    // false positives (shared name across different branches).
    const usable = members.filter((m) => !isUnusableScraperCoordinate(m.latitude, m.longitude));
    if (usable.length >= 2) {
      let maxD = 0;
      for (let i = 0; i < usable.length; i++) {
        for (let j = i + 1; j < usable.length; j++) {
          maxD = Math.max(
            maxD,
            haversineDistanceMeters(usable[i]!.latitude, usable[i]!.longitude, usable[j]!.latitude, usable[j]!.longitude)
          );
        }
      }
      if (maxD > MAX_GROUP_SPREAD_M) continue;
    }

    plans.push(buildMergePlanFromGroup(members, 'geo-proximity'));
  }

  return plans;
}

// ─── Executor ─────────────────────────────────────────────────────────────────

/**
 * Join premium notes from survivor and all losers with a clear separator so no
 * admin-entered text is silently dropped.
 */
export function mergePremiumNotesParts(...parts: (string | null | undefined)[]): string | undefined {
  const joined = parts.map((p) => (p ?? '').trim()).filter(Boolean);
  if (joined.length === 0) return undefined;
  return joined.join('\n\n--- merged from duplicate ---\n\n');
}

/**
 * Apply merge plans to the DB: union brands/tags/notes onto the surviving row,
 * delete PremiumStore rows for losers, delete Location rows for losers.
 * Returns the count of Location rows deleted.
 */
export async function executeDedupPlans(plans: MergePlan[]): Promise<number> {
  let duplicatesRemoved = 0;
  for (const plan of plans) {
    const loserHandles = plan.remove.map((r) => r.handle);

    const survivorPrem = await prisma.premiumStore.findUnique({ where: { handle: plan.keep.handle } });
    const loserNotes: string[] = [];
    for (const r of plan.remove) {
      const prem = await prisma.premiumStore.findUnique({ where: { handle: r.handle } });
      const n = prem?.notes?.trim();
      if (n) loserNotes.push(n);
    }

    await prisma.premiumStore.deleteMany({ where: { handle: { in: loserHandles } } });

    const mergedNotes = mergePremiumNotesParts(survivorPrem?.notes, ...loserNotes);
    if (survivorPrem) {
      if (loserNotes.length > 0 && mergedNotes) {
        await prisma.premiumStore.update({
          where: { handle: plan.keep.handle },
          data: { notes: mergedNotes },
        });
      }
    } else if (mergedNotes) {
      await prisma.premiumStore.create({
        data: { handle: plan.keep.handle, notes: mergedNotes },
      });
    }

    await prisma.location.update({
      where: { handle: plan.keep.handle },
      data: {
        name: plan.mergedName,
        brands: plan.mergedBrands,
        customBrands: plan.mergedCustomBrands,
        tags: plan.mergedTags,
      },
    });

    await prisma.location.deleteMany({ where: { handle: { in: loserHandles } } });
    duplicatesRemoved += loserHandles.length;
  }
  return duplicatesRemoved;
}

/** Prisma select shape for loading all rows into {@link buildDedupPlans} (matches merge CLI). */
const locationSelectForGlobalDedup = {
  handle: true,
  name: true,
  brands: true,
  customBrands: true,
  tags: true,
  addressLine1: true,
  city: true,
  country: true,
  latitude: true,
  longitude: true,
  isPremium: true,
  updatedAt: true,
} as const;

/**
 * Tier C — global post-ingest dedupe (same rules as merge-address-duplicate-locations.ts).
 * Loads every Location, builds fingerprint + geo-proximity merge plans, executes them.
 *
 * Intended to run after a successful scrape save or CSV import so cross-batch duplicates
 * are removed without a manual script. Can be slow on very large tables (full scan + O(n²) geo pass).
 */
export async function runGlobalPostIngestDedup(): Promise<{ mergeGroups: number; rowsRemoved: number }> {
  const rows = await prisma.location.findMany({
    select: locationSelectForGlobalDedup,
    orderBy: { handle: 'asc' },
  });
  const plans = buildDedupPlans(rows as MergeStoreRow[]);
  if (plans.length === 0) return { mergeGroups: 0, rowsRemoved: 0 };
  const rowsRemoved = await executeDedupPlans(plans);
  return { mergeGroups: plans.length, rowsRemoved };
}

async function loadMergeStoreRowsForDedup(handles: string[]): Promise<MergeStoreRow[]> {
  if (handles.length === 0) return [];
  return prisma.location.findMany({
    where: { handle: { in: handles } },
    select: locationSelectForGlobalDedup,
    orderBy: { handle: 'asc' },
  }) as Promise<MergeStoreRow[]>;
}

/**
 * Load rows for every handle that could share a Tier-C merge group with any seed:
 * - same deduped address fingerprint + same city + same country as any current member
 * - same city + country, within {@link MAX_GROUP_SPREAD_M} of any **seed** row's coordinates
 *   (anchors stay the ingest batch so we do not walk the whole map).
 *
 * Iterates until stable so fingerprint peers pulled in by geo are also fingerprint-expanded.
 */
export async function expandScopedDedupeCandidates(seedHandles: string[]): Promise<MergeStoreRow[]> {
  const seed = [...new Set(seedHandles.filter(Boolean))];
  if (seed.length === 0) return [];

  const handleSet = new Set(seed);
  const seedRows = await loadMergeStoreRowsForDedup(seed);

  for (let round = 0; round < SCOPED_EXPAND_ROUNDS; round++) {
    const sizeBefore = handleSet.size;

    const rowsThisRound = await loadMergeStoreRowsForDedup([...handleSet]);
    for (const r of rowsThisRound) {
      const fp = dedupeAddressFingerprint(r.addressLine1);
      if (fp.length < MIN_ADDRESS_FP_LEN) continue;
      const normCountry = normalizeCountry(r.country);
      const cityTrim = r.city.trim();
      const peers = await prisma.location.findMany({
        where: {
          country: normCountry,
          city: { equals: cityTrim, mode: 'insensitive' },
        },
        select: { handle: true, addressLine1: true },
      });
      for (const p of peers) {
        if (dedupeAddressFingerprint(p.addressLine1) === fp) handleSet.add(p.handle);
      }
    }

    for (const r of seedRows) {
      if (isUnusableScraperCoordinate(r.latitude, r.longitude)) continue;
      const normCountry = normalizeCountry(r.country);
      const cityLow = r.city.trim().toLowerCase();
      const box = boundingBoxForRadiusMeters(r.latitude, r.longitude, MAX_GROUP_SPREAD_M);
      const hits = await prisma.location.findMany({
        where: {
          country: normCountry,
          latitude: { gte: box.latMin, lte: box.latMax },
          longitude: { gte: box.lonMin, lte: box.lonMax },
        },
        select: { handle: true, city: true },
      });
      for (const h of hits) {
        if (h.city.trim().toLowerCase() === cityLow) handleSet.add(h.handle);
      }
    }

    if (handleSet.size === sizeBefore) break;
    if (handleSet.size > MAX_SCOPED_CANDIDATE_HANDLES) {
      throw new Error('SCOPED_CANDIDATE_OVERFLOW');
    }
  }

  if (handleSet.size > MAX_SCOPED_CANDIDATE_HANDLES) {
    throw new Error('SCOPED_CANDIDATE_OVERFLOW');
  }

  return loadMergeStoreRowsForDedup([...handleSet]);
}

/**
 * Tier C dedupe limited to rows related to this ingest: fingerprint peers and same-city
 * neighbors within {@link MAX_GROUP_SPREAD_M} of any touched coordinate. Same merge rules as
 * {@link runGlobalPostIngestDedup}, far fewer rows loaded when the batch is small.
 *
 * Falls back to {@link runGlobalPostIngestDedup} if the scoped candidate set exceeds
 * {@link MAX_SCOPED_CANDIDATE_HANDLES} (safety — no missed merges).
 */
export async function runScopedPostIngestDedup(
  touchedHandles: string[]
): Promise<{ mergeGroups: number; rowsRemoved: number; mode: 'scoped' | 'global-fallback' | 'none' }> {
  const unique = [...new Set(touchedHandles.filter(Boolean))];
  if (unique.length === 0) return { mergeGroups: 0, rowsRemoved: 0, mode: 'none' };

  try {
    const candidates = await expandScopedDedupeCandidates(unique);
    const plans = buildDedupPlans(candidates);
    if (plans.length === 0) return { mergeGroups: 0, rowsRemoved: 0, mode: 'scoped' };
    const rowsRemoved = await executeDedupPlans(plans);
    return { mergeGroups: plans.length, rowsRemoved, mode: 'scoped' };
  } catch (e: unknown) {
    if (e instanceof Error && e.message === 'SCOPED_CANDIDATE_OVERFLOW') {
      logger.warn(
        `[location-merge-core] Scoped dedupe exceeded ${MAX_SCOPED_CANDIDATE_HANDLES} candidates; ` +
          'falling back to global pass.'
      );
      const g = await runGlobalPostIngestDedup();
      return { mergeGroups: g.mergeGroups, rowsRemoved: g.rowsRemoved, mode: 'global-fallback' };
    }
    throw e;
  }
}
