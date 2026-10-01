import fs from 'fs';
import prisma from '../lib/prisma';
import { BRAND_CONFIGS_PATH } from '../utils/paths';

/** JSON baseline shipped with the app (ephemeral overrides merged from DB). */
function readFileBaseline(): Record<string, unknown> {
  try {
    if (!fs.existsSync(BRAND_CONFIGS_PATH)) return {};
    const raw = fs.readFileSync(BRAND_CONFIGS_PATH, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Effective brand map: file baseline minus baseline-excludes, then DB rows overlay (and add DB-only brands).
 */
export async function loadMergedBrandConfigs(): Promise<Record<string, any>> {
  const baseline = readFileBaseline();
  const [excludes, rows] = await Promise.all([
    prisma.brandConfigBaselineExclude.findMany({ select: { brandId: true } }),
    prisma.brandConfig.findMany(),
  ]);
  const excludeSet = new Set(excludes.map((e) => e.brandId));

  const merged: Record<string, any> = {};
  for (const [key, value] of Object.entries(baseline)) {
    if (key === '_README' || excludeSet.has(key)) continue;
    merged[key] = value;
  }
  for (const row of rows) {
    merged[row.brandId] = row.data as Record<string, any>;
  }
  return merged;
}

export async function upsertBrandConfigRow(brandId: string, data: Record<string, any>): Promise<void> {
  await prisma.brandConfig.upsert({
    where: { brandId },
    create: { brandId, data },
    update: { data },
  });
}

export async function removeBrandConfigRow(brandId: string): Promise<void> {
  await prisma.brandConfig.deleteMany({ where: { brandId } });
}

/** After rename: drop old DB row and hide old file key if it existed in baseline. */
export async function applyBrandRename(oldBrandId: string): Promise<void> {
  await removeBrandConfigRow(oldBrandId);
  const baseline = readFileBaseline();
  if (oldBrandId !== '_README' && baseline[oldBrandId] != null) {
    await prisma.brandConfigBaselineExclude.upsert({
      where: { brandId: oldBrandId },
      create: { brandId: oldBrandId },
      update: {},
    });
  }
}
