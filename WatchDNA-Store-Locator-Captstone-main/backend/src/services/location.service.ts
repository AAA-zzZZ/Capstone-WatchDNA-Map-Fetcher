import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../utils/logger';
import { parseRowToLocationData } from '../utils/csv-to-location';
import { storeService } from './store.service';
import { runScopedPostIngestDedup } from '../utils/location-merge-core';
import { locationCountryEqualsWhere } from '../utils/location-country-filter';
import { legacyBrandTextFilterWhere } from '../utils/legacy-brand-filter';
import { brandConfigIdToDisplayName, normalizeBrandsCsvField } from '../utils/brand-display-name';
import { locationTableHasBrandFilterModeColumn } from '../utils/location-brand-filter-column';
import { locationScalarSelectWithoutBrandFilterMode } from '../utils/location-scalar-select-without-brand-filter';

export interface LocationFilters {
  brand?: string;
  country?: string;
  city?: string;
  status?: boolean;
  isPremium?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface NearbyParams {
  latitude: number;
  longitude: number;
  radius: number; // in miles
  filters?: LocationFilters;
}

export interface ImportResult {
  success: boolean;
  newCount: number;
  updatedCount: number;
  /** Rows upserted with no field changes vs prior DB snapshot. */
  unchangedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: string[];
  /** Set after successful CSV import: Tier-C dedupe (merge-address-dupes rules), scoped to this ingest. */
  dedupeMergeGroups?: number;
  dedupeRowsRemoved?: number;
  /** `scoped` = neighborhood of touched handles; `global-fallback` = cap exceeded, full table pass. */
  dedupeMode?: 'scoped' | 'global-fallback' | 'none';
}

function inferBrandFromFilename(filename: string): string | null {
  const base = path.basename(filename, path.extname(filename)).trim();
  if (!base) return null;
  const dePrefixed = base.replace(/^[0-9a-f]{8,}-/i, '');
  const normalized = dePrefixed.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return null;

  // Best signal: explicit "<brand>_stores|retailers|dealers|watches" in filename.
  const configLikeMatch = normalized.match(/([a-z0-9]+(?:_[a-z0-9]+)*_(?:stores|retailers|dealers|watches))/);
  if (configLikeMatch?.[1]) {
    const display = brandConfigIdToDisplayName(configLikeMatch[1]);
    if (display) return display;
  }

  return null;
}

async function resolveImportBrandFallback(
  uploadId: string | undefined,
  csvFilePath: string
): Promise<string | null> {
  if (!uploadId) {
    return inferBrandFromFilename(csvFilePath);
  }
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    select: {
      brandConfig: true,
      originalFilename: true,
      filename: true,
    },
  });
  if (!upload) {
    return inferBrandFromFilename(csvFilePath);
  }

  const fromConfig = brandConfigIdToDisplayName(upload.brandConfig ?? '');
  if (fromConfig) return fromConfig;

  return (
    inferBrandFromFilename(upload.originalFilename) ??
    inferBrandFromFilename(upload.filename) ??
    inferBrandFromFilename(csvFilePath)
  );
}

function enrichRowsWithNormalizedBrands(
  rows: Record<string, string>[],
  fallbackBrand: string | null
): Record<string, string>[] {
  if (!fallbackBrand) {
    return rows.map((row) => {
      const normalized = normalizeBrandsCsvField(row.Brands);
      if (!normalized || normalized === row.Brands) return row;
      return { ...row, Brands: normalized };
    });
  }
  return rows.map((row) => {
    const normalized = normalizeBrandsCsvField(row.Brands);
    return {
      ...row,
      Brands: normalized ?? fallbackBrand,
    };
  });
}

class LocationService {
  private async premiumFilterBrandsByHandle(handles: string[]): Promise<Map<string, string[]>> {
    const normalizedHandles = handles.map((h) => h.trim()).filter(Boolean);
    if (normalizedHandles.length === 0) return new Map();

    const rows = await (prisma as any).storePremiumBrand.findMany({
      where: { handle: { in: normalizedHandles } },
      select: { handle: true, brandName: true },
      orderBy: [{ handle: 'asc' }, { brandName: 'asc' }],
    });

    const map = new Map<string, string[]>();
    for (const row of rows) {
      const handle = row.handle.trim();
      if (!map.has(handle)) map.set(handle, []);
      map.get(handle)!.push(row.brandName);
    }
    return map;
  }

  private async attachPremiumFilterBrands<T extends { handle: string }>(
    rows: T[]
  ): Promise<Array<T & { premiumFilterBrands: string[] }>> {
    if (rows.length === 0) return [];
    const byHandle = await this.premiumFilterBrandsByHandle(rows.map((r) => r.handle));
    return rows.map((row) => ({
      ...row,
      premiumFilterBrands: byHandle.get(row.handle) ?? [],
    }));
  }

  /**
   * Import locations from CSV file to database.
   * Uses batched transactions with per-batch fallback to per-row upserts, same dedupe/merge
   * pipeline as scraper jobs, with manual merge rules (CSV phone applies when non-empty).
   *
   * @param uploadId When set (e.g. admin CSV upload), stamps Location.uploadId for reporting.
   */
  async importFromCSV(csvFilePath: string, uploadId?: string): Promise<ImportResult> {
    const result: ImportResult = {
      success: false,
      newCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      errors: []
    };

    try {
      const fileContent = fs.readFileSync(csvFilePath, 'utf-8');
      const parseResult = Papa.parse(fileContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.trim()
      });

      const rows = parseResult.data as Record<string, string>[];
      const fallbackBrand = await resolveImportBrandFallback(uploadId, csvFilePath);
      const enrichedRows = enrichRowsWithNormalizedBrands(rows, fallbackBrand);
      if (fallbackBrand) {
        logger.warn(`[LocationService] Import brand fallback inferred: ${fallbackBrand}`);
      }
      logger.warn(`[LocationService] Importing ${rows.length} rows from CSV...`);

      for (const row of enrichedRows) {
        if (!parseRowToLocationData(row) && (row.Name || row.Handle)) {
          result.errors.push(`Invalid or missing required fields for: ${row.Name || row.Handle}`);
        }
      }

      const upsert = await storeService.batchUpsertLocations(enrichedRows, uploadId, {
        failFast: true,
        requireCompleteForDb: true,
        mergeOnUpdate: true,
        mergeKind: 'manual',
      });

      result.newCount = upsert.created;
      result.updatedCount = upsert.updated;
      result.unchangedCount = upsert.unchanged;
      result.skippedCount = upsert.skipped;
      result.errorCount = upsert.failed ?? 0;
      if (upsert.dbErrors && upsert.dbErrors.length > 0) {
        result.errors.push(...upsert.dbErrors);
      }

      result.success = true;
      logger.warn(
        `[LocationService] Import complete: ${result.newCount} new, ${result.updatedCount} updated, ` +
        `${result.unchangedCount} unchanged, ${result.skippedCount} skipped, ${result.errorCount} errors`
      );

      try {
        const dedup = await runScopedPostIngestDedup(upsert.affectedHandles ?? []);
        result.dedupeMergeGroups = dedup.mergeGroups;
        result.dedupeRowsRemoved = dedup.rowsRemoved;
        result.dedupeMode = dedup.mode;
        if (dedup.mergeGroups > 0) {
          logger.warn(
            `[LocationService] Post-import dedupe (${dedup.mode}): ${dedup.mergeGroups} merge group(s), ` +
              `${dedup.rowsRemoved} duplicate row(s) removed`
          );
        }
      } catch (dedupErr: any) {
        logger.error('[LocationService] Post-import dedupe failed (non-fatal):', dedupErr.message);
      }
    } catch (error: any) {
      result.success = false;
      result.errors.push(`Failed to read/parse CSV: ${error.message}`);
      logger.error('[LocationService] Import failed:', error);
    }

    return result;
  }

  /**
   * Get all locations with optional filtering and pagination.
   */
  async findAll(filters: LocationFilters = {}) {
    const {
      brand,
      country,
      city,
      status,
      isPremium,
      search,
      limit = 100,
      offset = 0
    } = filters;

    const where: Prisma.LocationWhereInput = {};
    const andClauses: Prisma.LocationWhereInput[] = [];

    if (brand) {
      andClauses.push(legacyBrandTextFilterWhere(brand));
    }
    const countryClause = locationCountryEqualsWhere(country);
    if (countryClause) Object.assign(where, countryClause);
    if (city) {
      where.city = city;
    }

    if (status !== undefined) {
      where.status = status;
    }

    if (isPremium === true) {
      andClauses.push({
        OR: [
          { isPremium: true },
          { isVerifiedDealer: true },
          { isBoutique: true },
          { isServiceCenter: true },
        ],
      });
    }

    if (search) {
      where.name = { contains: search, mode: 'insensitive' };
    }

    if (andClauses.length > 0) {
      where.AND = andClauses;
    }

    const hasBrandFilterCol = await locationTableHasBrandFilterModeColumn();
    const [locations, total] = await Promise.all([
      prisma.location.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { name: 'asc' },
        ...(hasBrandFilterCol ? {} : { select: locationScalarSelectWithoutBrandFilterMode }),
      }),
      prisma.location.count({ where })
    ]);
    const enrichedLocations = await this.attachPremiumFilterBrands(locations);

    return {
      data: enrichedLocations,
      total,
      page: Math.floor(offset / limit) + 1,
      limit,
      hasMore: offset + limit < total
    };
  }

  /**
   * Find locations near a specific coordinate within a radius.
   */
  async findNearby(params: NearbyParams) {
    const { latitude, longitude, radius, filters = {} } = params;

    const { data: allLocations } = await this.findAll({
      ...filters,
      limit: 10000
    });

    const locationsWithDistance = allLocations.map(location => ({
      ...location,
      distance: this.calculateDistance(latitude, longitude, location.latitude, location.longitude)
    }));

    const nearbyLocations = locationsWithDistance
      .filter(loc => loc.distance <= radius)
      .sort((a, b) => a.distance - b.distance);

    return {
      data: nearbyLocations,
      total: nearbyLocations.length,
      centerLat: latitude,
      centerLng: longitude,
      radius
    };
  }

  /**
   * Find a single location by ID.
   */
  async findById(id: string) {
    const hasBrandFilterCol = await locationTableHasBrandFilterModeColumn();
    const row = await prisma.location.findUnique({
      where: { id },
      ...(hasBrandFilterCol ? {} : { select: locationScalarSelectWithoutBrandFilterMode }),
    });
    if (!row) return null;
    const [enriched] = await this.attachPremiumFilterBrands([row]);
    return enriched ?? null;
  }

  /**
   * Search locations by name or address (case-insensitive on PostgreSQL).
   */
  async search(query: string, limit: number = 50) {
    const hasBrandFilterCol = await locationTableHasBrandFilterModeColumn();
    const locations = await prisma.location.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { addressLine1: { contains: query, mode: 'insensitive' } },
          { city: { contains: query, mode: 'insensitive' } }
        ]
      },
      take: limit,
      orderBy: { name: 'asc' },
      ...(hasBrandFilterCol ? {} : { select: locationScalarSelectWithoutBrandFilterMode }),
    });
    const enrichedLocations = await this.attachPremiumFilterBrands(locations);

    return { data: enrichedLocations, total: enrichedLocations.length, query };
  }

  /**
   * Get unique list of brands from all locations (both brands and customBrands columns).
   * Strips HTML tags before splitting so malformed anchors don't leak raw markup.
   * Applies brandConfigIdToDisplayName for alias resolution and case-insensitive dedup.
   */
  async getBrands() {
    const locations = await prisma.location.findMany({
      select: { brands: true, customBrands: true },
      where: {
        AND: [
          {
            OR: [
              { brands: { not: null } },
              { customBrands: { not: null } }
            ]
          },
          {
            OR: [
              { isVerifiedDealer: true },
              { isBoutique: true },
              { isServiceCenter: true }
            ]
          }
        ]
      }
    });

    const seen = new Set<string>();
    const brandsSet = new Set<string>();

    const addTokens = (raw: string) => {
      // Strip all HTML tags (handles malformed HTML missing closing tags)
      const text = raw.replace(/<[^>]+>/g, '');
      for (const token of text.split(',')) {
        const display = brandConfigIdToDisplayName(token);
        if (!display) continue;
        const key = display.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        brandsSet.add(display);
      }
    };

    for (const loc of locations) {
      if (loc.brands) addTokens(loc.brands);
      if (loc.customBrands) addTokens(loc.customBrands);
    }

    return Array.from(brandsSet).sort();
  }

  async getPremiumFilterBrands() {
    const rows = await (prisma as any).storePremiumBrand.findMany({
      where: {
        location: {
          OR: [
            { isVerifiedDealer: true },
            { isBoutique: true },
            { isServiceCenter: true },
          ],
        },
      },
      select: { brandName: true },
      distinct: ['brandName'],
      orderBy: { brandName: 'asc' },
    });
    // DB distinct is exact-string only; stored rows can hold display variants of one brand
    // (e.g. "BALL" and "BALL WATCH"). Normalize to canonical display names and dedupe.
    const seen = new Set<string>();
    const brands: string[] = [];
    for (const row of rows as { brandName: string }[]) {
      const display = brandConfigIdToDisplayName(row.brandName ?? '');
      if (!display) continue;
      const key = display.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      brands.push(display);
    }
    return brands.sort();
  }

  /**
   * Get statistics about locations.
   */
  async getStats() {
    const [total, activeCount, countries, cities, brands] = await Promise.all([
      prisma.location.count(),
      prisma.location.count({ where: { status: true } }),
      prisma.location.groupBy({ by: ['country'], _count: true }),
      prisma.location.groupBy({ by: ['city'], _count: true }),
      this.getBrands()
    ]);

    return {
      total,
      active: activeCount,
      inactive: total - activeCount,
      countries: countries.length,
      cities: cities.length,
      brands: brands.length,
      topCountries: countries
        .sort((a, b) => b._count - a._count)
        .slice(0, 10)
        .map(c => ({ country: c.country, count: c._count })),
      topCities: cities
        .sort((a, b) => b._count - a._count)
        .slice(0, 10)
        .map(c => ({ city: c.city, count: c._count }))
    };
  }

  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3959; // miles
    const dLat = this.deg2rad(lat2 - lat1);
    const dLon = this.deg2rad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c * 10) / 10;
  }

  private deg2rad(deg: number): number {
    return deg * (Math.PI / 180);
  }
}

export default new LocationService();
