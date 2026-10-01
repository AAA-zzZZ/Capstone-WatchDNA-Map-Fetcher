/**
 * Geo-Verify Pipeline
 *
 * Runs coordinate verification (geocoding) for all stores of a given brand, then
 * performs a brand-scoped address-fingerprint + geo-proximity deduplication pass to
 * merge any stores whose coordinates were previously wrong and now resolve to the
 * same physical location.  Brand fields are unioned on the surviving row so no
 * brand association is lost.
 */

import prisma from '../lib/prisma';
import { legacyBrandTextFilterWhere } from '../utils/legacy-brand-filter';
import {
  buildDedupPlans,
  executeDedupPlans,
  type MergeStoreRow,
} from '../utils/location-merge-core';
import { verifyHandles, type VerifyHandlesSummary } from './coordinate-verification.service';

// ─── Task state (in-memory) ────────────────────────────────────────────────────

export type GeoVerifyPipelineResult = {
  coordinatesUpdated: number;
  verifiedStampOnly: number;
  geocodeFailed: number;
  errors: number;
  dedupMerged: number;
  locationsRemaining: number;
  elapsedSec: number;
};

export type GeoVerifyTask = {
  id: string;
  brandName: string;
  status: 'running' | 'done' | 'error';
  progress: { checked: number; total: number };
  phase: 'geocoding' | 'dedup' | 'done';
  log: string[];
  result?: GeoVerifyPipelineResult;
  error?: string;
  startedAt: Date;
  /** Set when status becomes done or error — used to evict old tasks from {@link geoVerifyTasks}. */
  finishedAt?: Date;
};

/** Shared in-memory task registry — lives for the lifetime of the server process. */
export const geoVerifyTasks = new Map<string, GeoVerifyTask>();

const GEO_VERIFY_FINISHED_MAX_AGE_MS = 30 * 60 * 1000;
const GEO_VERIFY_TASK_MAP_MAX = 100;
const GEO_VERIFY_LOG_MAX_LINES = 400;

/** Mark a task finished for TTL / map-size pruning (idempotent). */
export function markGeoVerifyTaskFinished(task: GeoVerifyTask): void {
  if (!task.finishedAt) task.finishedAt = new Date();
}

/**
 * Drop old finished tasks and enforce a hard cap so long-lived servers do not grow memory without bound.
 * Safe to call on every status poll or new-task start.
 */
export function pruneGeoVerifyTasks(): void {
  const now = Date.now();
  for (const [id, t] of geoVerifyTasks) {
    if (t.status === 'running') continue;
    const fin = t.finishedAt?.getTime();
    if (fin !== undefined && now - fin > GEO_VERIFY_FINISHED_MAX_AGE_MS) {
      geoVerifyTasks.delete(id);
    }
  }
  while (geoVerifyTasks.size > GEO_VERIFY_TASK_MAP_MAX) {
    let oldest: { id: string; t: number } | null = null;
    for (const [id, t] of geoVerifyTasks) {
      if (t.status === 'running') continue;
      const fin = t.finishedAt?.getTime() ?? 0;
      if (!oldest || fin < oldest.t) oldest = { id, t: fin };
    }
    if (!oldest) break;
    geoVerifyTasks.delete(oldest.id);
  }
}

/** DB select shape for the brand-scoped dedup pass — must satisfy MergeStoreRow. */
type BrandScopedStoreRow = MergeStoreRow;

// ─── Main pipeline ────────────────────────────────────────────────────────────

export async function runGeoVerifyPipeline(task: GeoVerifyTask): Promise<void> {
  const wallStart = Date.now();

  const appendLog = (msg: string) => {
    task.log.push(msg);
    if (task.log.length > GEO_VERIFY_LOG_MAX_LINES) {
      task.log.splice(0, task.log.length - GEO_VERIFY_LOG_MAX_LINES);
    }
  };

  try {
    const brandWhere = legacyBrandTextFilterWhere(task.brandName);
    const storeRows = await prisma.location.findMany({
      where: brandWhere,
      select: { handle: true },
    });
    const handles = storeRows.map((r) => r.handle);
    task.progress.total = handles.length;

    if (handles.length === 0) {
      appendLog(`No stores found for brand "${task.brandName}".`);
      task.status = 'done';
      task.phase = 'done';
      task.result = {
        coordinatesUpdated: 0,
        verifiedStampOnly: 0,
        geocodeFailed: 0,
        errors: 0,
        dedupMerged: 0,
        locationsRemaining: 0,
        elapsedSec: 0,
      };
      markGeoVerifyTaskFinished(task);
      return;
    }

    appendLog(`Found ${handles.length} store(s) for brand "${task.brandName}".`);
    appendLog('Phase 1: Running coordinate verification (geocoding)...');

    // Phase 1: geocode each store, updating coordinates where Nominatim disagrees
    let verifySummary: VerifyHandlesSummary;
    try {
      verifySummary = await verifyHandles(handles, {
        forceReverify: true,
        onProgress: (processed, total) => {
          task.progress.checked = processed;
          task.progress.total = total;
        },
      });
    } catch (e: unknown) {
      throw new Error(`Geocoding phase failed: ${String(e)}`);
    }

    appendLog(
      `Geocoding complete — ` +
      `${verifySummary.coordinatesUpdated} coordinate(s) updated, ` +
      `${verifySummary.verifiedStampOnly} confirmed (no change), ` +
      `${verifySummary.geocodeFailed} geocode failure(s), ` +
      `${verifySummary.errors} error(s).`
    );

    // Phase 2: brand-scoped deduplication now that coordinates are fresh
    task.phase = 'dedup';
    appendLog('Phase 2: Running address deduplication for this brand...');

    const freshStores = await prisma.location.findMany({
      where: brandWhere,
      select: {
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
      },
      orderBy: { handle: 'asc' },
    });

    // Brand-scoped: freshStores is already filtered to this brand so buildDedupPlans
    // only compares within the brand (Tier B — see location-merge-core.ts).
    const plans = buildDedupPlans(freshStores as BrandScopedStoreRow[]);
    appendLog(`Found ${plans.length} merge group(s).`);

    const dedupMerged = await executeDedupPlans(plans);
    if (dedupMerged > 0) {
      appendLog(`Removed ${dedupMerged} duplicate location(s). Brand fields were unioned onto surviving rows.`);
    } else {
      appendLog('No duplicate locations found after deduplication.');
    }

    const remaining = await prisma.location.count({ where: brandWhere });
    const elapsedSec = (Date.now() - wallStart) / 1000;
    appendLog(`Done. ${remaining} store(s) remaining. Elapsed: ${elapsedSec.toFixed(1)}s`);

    task.status = 'done';
    task.phase = 'done';
    task.result = {
      coordinatesUpdated: verifySummary.coordinatesUpdated,
      verifiedStampOnly: verifySummary.verifiedStampOnly,
      geocodeFailed: verifySummary.geocodeFailed,
      errors: verifySummary.errors,
      dedupMerged,
      locationsRemaining: remaining,
      elapsedSec,
    };
    markGeoVerifyTaskFinished(task);
  } catch (e: unknown) {
    task.status = 'error';
    task.phase = 'done';
    task.error = String(e);
    appendLog(`Error: ${String(e)}`);
    markGeoVerifyTaskFinished(task);
  }
}
