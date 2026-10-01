/**
 * Premium store service — manages which stores are marked as premium.
 * `PremiumStore` is the registry (source of truth for “in premium program”);
 * `Location.isPremium` is kept in sync for fast reads — use reconcile after bulk imports if drift is suspected.
 */

import type { Prisma } from '@prisma/client';

import prisma from '../lib/prisma';
import { locationTableHasBrandFilterModeColumn } from '../utils/location-brand-filter-column';
import { locationTableHasShopifyFileGidColumn } from '../utils/location-shopify-gid-column';
import { locationTableHasShopifyExclusiveUploadColumn } from '../utils/location-shopify-exclusive-column';
import {
  brandConfigIdToDisplayName,
  normalizeBrandsCsvField,
  removeBrandsFromCustomBrandsField,
} from '../utils/brand-display-name';
import { normalizeCountry } from '../utils/country';
import { normalizePhone } from '../utils/normalize-phone';
import {
  STORE_IMAGE_PUBLIC_PREFIX,
  isValidStoreImageFilename,
  managedImageFilenameFromUrl,
  removeStoreImageFile,
} from '../utils/store-premium-image';
import { buildManualMergePlan, mergePremiumNotesParts, type MergeStoreRow } from '../utils/location-merge-core';

export const STORE_LISTING_AUTHORIZED_DEALERS = 'Authorized Dealers';
export const STORE_LISTING_AD_VERIFIED = 'AD Verified';
export const STORE_LISTING_VERIFIED_DEALER = 'Verified Authorized Dealer';
export const STORE_LISTING_BOUTIQUE = 'Boutique Verified';
export const STORE_LISTING_SERVICE_CENTER = 'Service center';
export const STORE_LISTING_STANDARD = 'Standard';

export type StoreListingType = string;

export type BrandFilterModeWire = 'brand' | 'verified_brand';

function brandFilterModeFromDb(v: string | null | undefined): BrandFilterModeWire {
  return v === 'verified_brand' ? 'verified_brand' : 'brand';
}

function storeTypeFromCategoryFlags(
  isVerifiedDealer: boolean,
  isBoutique: boolean,
  isServiceCenter: boolean
): string {
  const parts: string[] = [];
  if (isVerifiedDealer) parts.push(STORE_LISTING_VERIFIED_DEALER);
  if (isBoutique) parts.push(STORE_LISTING_BOUTIQUE);
  if (isServiceCenter) parts.push(STORE_LISTING_SERVICE_CENTER);
  return parts.length > 0 ? parts.join(' · ') : STORE_LISTING_STANDARD;
}

function anyPremiumCategory(
  isVerifiedDealer: boolean,
  isBoutique: boolean,
  isServiceCenter: boolean
): boolean {
  return isVerifiedDealer || isBoutique || isServiceCenter;
}

export interface PremiumStoreRecord {
  handle: string;
  name: string;
  nameEn: string | null;
  addressLine1: string;
  addressLine1En: string | null;
  addressLine2: string | null;
  city: string;
  cityEn: string | null;
  stateProvinceRegion: string | null;
  country: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  phone: string | null;
  brands: string | null;
  customBrands: string | null;
  isPremium: boolean;
  website: string | null;
  imageUrl: string | null;
  pageDescription: string | null;
  monday: string | null;
  tuesday: string | null;
  wednesday: string | null;
  thursday: string | null;
  friday: string | null;
  saturday: string | null;
  sunday: string | null;
  /** Human-readable category labels (joined) for the admin list. */
  storeType: StoreListingType;
  brandFilterMode: BrandFilterModeWire;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
  premiumFilterBrands: string[];
}

const premiumStoreSelect = {
  handle: true,
  name: true,
  nameEn: true,
  addressLine1: true,
  addressLine1En: true,
  addressLine2: true,
  city: true,
  cityEn: true,
  stateProvinceRegion: true,
  country: true,
  postalCode: true,
  latitude: true,
  longitude: true,
  phone: true,
  brands: true,
  customBrands: true,
  isPremium: true,
  isVerifiedDealer: true,
  isBoutique: true,
  isServiceCenter: true,
  website: true,
  imageUrl: true,
  pageDescription: true,
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: true,
  sunday: true,
  brandFilterMode: true,
} as const;

/** Same as `premiumStoreSelect` when the DB has migrated; used when `brandFilterMode` column is absent. */
const premiumStoreSelectNoBrandFilter: Omit<typeof premiumStoreSelect, 'brandFilterMode'> = (() => {
  const copy = { ...premiumStoreSelect };
  delete (copy as Record<string, unknown>).brandFilterMode;
  return copy;
})();

async function selectForPremiumLocationRow(): Promise<
  typeof premiumStoreSelect | typeof premiumStoreSelectNoBrandFilter
> {
  return (await locationTableHasBrandFilterModeColumn()) ? premiumStoreSelect : premiumStoreSelectNoBrandFilter;
}

function toPremiumRecord(loc: {
  handle: string;
  name: string;
  nameEn: string | null;
  addressLine1: string;
  addressLine1En: string | null;
  addressLine2: string | null;
  city: string;
  cityEn: string | null;
  stateProvinceRegion: string | null;
  country: string;
  postalCode: string | null;
  latitude: number;
  longitude: number;
  phone: string | null;
  brands: string | null;
  customBrands: string | null;
  isPremium: boolean;
  website: string | null;
  imageUrl: string | null;
  pageDescription: string | null;
  monday: string | null;
  tuesday: string | null;
  wednesday: string | null;
  thursday: string | null;
  friday: string | null;
  saturday: string | null;
  sunday: string | null;
  brandFilterMode?: string | null;
  isVerifiedDealer?: boolean | null;
  isBoutique?: boolean | null;
  isServiceCenter?: boolean | null;
}, premiumFilterBrands: string[] = []): PremiumStoreRecord {
  const vd = Boolean(loc.isVerifiedDealer);
  const bt = Boolean(loc.isBoutique);
  const sc = Boolean(loc.isServiceCenter);
  const listing = storeTypeFromCategoryFlags(vd, bt, sc);
  return {
    ...loc,
    country: normalizeCountry(loc.country ?? '') || '',
    storeType: listing,
    brandFilterMode: brandFilterModeFromDb(loc.brandFilterMode),
    isVerifiedDealer: vd,
    isBoutique: bt,
    isServiceCenter: sc,
    premiumFilterBrands,
  };
}

function normalizePremiumFilterBrands(input: string[] | null | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const normalized = brandConfigIdToDisplayName(raw);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function loadPremiumFilterBrandsByHandle(handles: string[]): Promise<Map<string, string[]>> {
  const normalizedHandles = handles.map((h) => h.trim()).filter(Boolean);
  if (normalizedHandles.length === 0) return new Map();

  const rows = await (prisma as any).storePremiumBrand.findMany({
    where: { handle: { in: normalizedHandles } },
    select: { handle: true, brandName: true },
    orderBy: [{ handle: 'asc' }, { brandName: 'asc' }],
  });

  const map = new Map<string, string[]>();
  for (const row of rows) {
    const key = row.handle.trim();
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(row.brandName);
  }
  return map;
}

function normalizeHandles(handles: string[]): string[] {
  return [...new Set(handles.map((h) => h.trim()).filter(Boolean))];
}

/** PATCH body: only these keys may update Location (plus optional isPremium for registry sync). */
export type PremiumStoreUpdateInput = Partial<{
  name: string;
  nameEn: string | null;
  addressLine1: string;
  addressLine1En: string | null;
  addressLine2: string | null;
  city: string;
  cityEn: string | null;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  website: string | null;
  imageUrl: string | null;
  pageDescription: string | null;
  brands: string | null;
  monday: string | null;
  tuesday: string | null;
  wednesday: string | null;
  thursday: string | null;
  friday: string | null;
  saturday: string | null;
  sunday: string | null;
  isPremium: boolean;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
  brandFilterMode: BrandFilterModeWire | null;
  premiumFilterBrands: string[];
  /** Shopify file GID to store alongside a new imageUrl (e.g. when picking from Shopify Files). */
  shopifyFileGid: string | null;
  latitude: number | null;
  longitude: number | null;
}>;

export type MarkPremiumEntry = {
  handle: string;
  isVerifiedDealer: boolean;
  isBoutique: boolean;
  isServiceCenter: boolean;
};

/** Max locations in one manual merge (keep + others). */
export const MERGE_MANUAL_MAX_STORES = 25;

export type ManualMergeMergedStorePayload = {
  name: string;
  nameEn: string | null;
  addressLine1: string;
  addressLine1En: string | null;
  addressLine2: string | null;
  city: string;
  cityEn: string | null;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  website: string | null;
  latitude: number;
  longitude: number;
};

function assertValidMergeCoords(lat: unknown, lng: unknown): void {
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    throw new Error('MERGE_INVALID_COORDS');
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('MERGE_INVALID_COORDS');
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error('MERGE_INVALID_COORDS');
  }
}

/**
 * Validate POST /premium-stores/stores/merge JSON. Throws Error with message MERGE_INVALID_BODY or MERGE_INVALID_COORDS.
 */
export function parseManualMergeBody(body: unknown): {
  keepHandle: string;
  otherHandles: string[];
  mergedStore: ManualMergeMergedStorePayload;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('MERGE_INVALID_BODY');
  }
  const b = body as Record<string, unknown>;
  const keepHandle = typeof b.keepHandle === 'string' ? b.keepHandle.trim() : '';
  const oh = b.otherHandles;
  if (!keepHandle) {
    throw new Error('MERGE_INVALID_BODY');
  }
  if (!Array.isArray(oh) || oh.length === 0) {
    throw new Error('MERGE_INVALID_BODY');
  }
  const otherHandles: string[] = [];
  for (const h of oh) {
    if (typeof h !== 'string' || !h.trim()) {
      throw new Error('MERGE_INVALID_BODY');
    }
    otherHandles.push(h.trim());
  }
  const ms = b.mergedStore;
  if (ms === null || typeof ms !== 'object' || Array.isArray(ms)) {
    throw new Error('MERGE_INVALID_BODY');
  }
  const m = ms as Record<string, unknown>;
  const reqStr = (k: string): string => {
    const v = m[k];
    if (typeof v !== 'string') {
      throw new Error('MERGE_INVALID_BODY');
    }
    return v.trim();
  };
  const optStrNull = (k: string): string | null => {
    const v = m[k];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') {
      throw new Error('MERGE_INVALID_BODY');
    }
    const t = v.trim();
    return t === '' ? null : t;
  };
  const name = reqStr('name');
  const addressLine1 = reqStr('addressLine1');
  const city = reqStr('city');
  const countryRaw = reqStr('country');
  if (!name || !addressLine1 || !city || !countryRaw) {
    throw new Error('MERGE_INVALID_BODY');
  }
  assertValidMergeCoords(m.latitude, m.longitude);
  return {
    keepHandle,
    otherHandles,
    mergedStore: {
      name,
      nameEn: optStrNull('nameEn'),
      addressLine1,
      addressLine1En: optStrNull('addressLine1En'),
      addressLine2: optStrNull('addressLine2'),
      city,
      cityEn: optStrNull('cityEn'),
      stateProvinceRegion: optStrNull('stateProvinceRegion'),
      postalCode: optStrNull('postalCode'),
      country: countryRaw,
      phone: optStrNull('phone'),
      website: optStrNull('website'),
      latitude: m.latitude as number,
      longitude: m.longitude as number,
    },
  };
}

function emptyToNull(s: string | null | undefined): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t === '' ? null : t;
}

export const premiumService = {
  /**
   * Fetch all stores from the Location table with only the fields needed
   * for the premium management UI.
   */
  async getStores(): Promise<PremiumStoreRecord[]> {
    const locSelect = await selectForPremiumLocationRow();
    const rows = await prisma.location.findMany({
      select: locSelect,
      orderBy: { name: 'asc' },
    });
    const premiumBrandsByHandle = await loadPremiumFilterBrandsByHandle(rows.map((r) => r.handle));
    return rows.map((loc) => toPremiumRecord(loc, premiumBrandsByHandle.get(loc.handle) ?? []));
  },

  /**
   * Update one store by handle. Unknown body keys are ignored.
   * Returns null if the handle does not exist.
   */
  async updateStoreByHandle(
    handle: string,
    body: PremiumStoreUpdateInput
  ): Promise<PremiumStoreRecord | null> {
    const h = handle.trim();
    if (!h) return null;

    const locSelect = await selectForPremiumLocationRow();
    const existing = await prisma.location.findUnique({
      where: { handle: h },
      select: locSelect,
    });
    if (!existing) return null;

    const data: Prisma.LocationUpdateInput = {};
    let nextCountry = normalizeCountry(existing.country ?? '') || existing.country;

    if (body.name !== undefined) {
      data.name = (body.name ?? '').trim() || existing.name;
    }
    if (body.nameEn !== undefined) {
      data.nameEn = emptyToNull(body.nameEn);
    }
    if (body.addressLine1 !== undefined) {
      data.addressLine1 = (body.addressLine1 ?? '').trim() || existing.addressLine1;
    }
    if (body.addressLine1En !== undefined) {
      data.addressLine1En = emptyToNull(body.addressLine1En);
    }
    if (body.addressLine2 !== undefined) {
      data.addressLine2 = emptyToNull(body.addressLine2);
    }
    if (body.city !== undefined) {
      data.city = (body.city ?? '').trim() || existing.city;
    }
    if (body.cityEn !== undefined) {
      data.cityEn = emptyToNull(body.cityEn);
    }
    if (body.stateProvinceRegion !== undefined) {
      data.stateProvinceRegion = emptyToNull(body.stateProvinceRegion);
    }
    if (body.postalCode !== undefined) {
      data.postalCode = emptyToNull(body.postalCode);
    }
    if (body.country !== undefined) {
      const norm = normalizeCountry((body.country ?? '').trim()) || (body.country ?? '').trim();
      data.country = norm || existing.country;
      nextCountry = norm || existing.country;
    }
    if (body.website !== undefined) {
      data.website = emptyToNull(body.website);
    }
    if (body.brands !== undefined) {
      // Same rules as CSV import: strip HTML, apply aliases, drop address-like junk, dedupe
      data.brands = normalizeBrandsCsvField(body.brands) ?? null;
      // Brands the admin explicitly removed must also leave the legacy Custom Brands links —
      // the map's brand filter falls back to customBrands when brands/premiumFilterBrands are
      // empty, so a removed brand would otherwise keep matching the store. Brands not present
      // before are untouched, so legacy customBrands-only stores are unaffected.
      const tokenSet = (csv: string | null | undefined) =>
        new Set(
          String(csv ?? '')
            .split(',')
            .map((t) => brandConfigIdToDisplayName(t).toLowerCase())
            .filter(Boolean)
        );
      const nextTokens = tokenSet(data.brands as string | null);
      const removedTokens = [...tokenSet(existing.brands)].filter((t) => !nextTokens.has(t));
      if (removedTokens.length > 0 && existing.customBrands) {
        data.customBrands = removeBrandsFromCustomBrandsField(existing.customBrands, removedTokens);
      }
    }
    if (body.imageUrl !== undefined) {
      data.imageUrl = emptyToNull(body.imageUrl);
    }
    if (body.pageDescription !== undefined) {
      data.pageDescription = emptyToNull(body.pageDescription);
    }
    if (body.monday !== undefined) data.monday = emptyToNull(body.monday);
    if (body.tuesday !== undefined) data.tuesday = emptyToNull(body.tuesday);
    if (body.wednesday !== undefined) data.wednesday = emptyToNull(body.wednesday);
    if (body.thursday !== undefined) data.thursday = emptyToNull(body.thursday);
    if (body.friday !== undefined) data.friday = emptyToNull(body.friday);
    if (body.saturday !== undefined) data.saturday = emptyToNull(body.saturday);
    if (body.sunday !== undefined) data.sunday = emptyToNull(body.sunday);
    if (body.phone !== undefined) {
      const raw = body.phone === null ? '' : String(body.phone);
      data.phone = normalizePhone(raw, nextCountry);
    }
    if (body.latitude !== undefined && body.latitude !== null && Number.isFinite(body.latitude)) {
      data.latitude = body.latitude;
    }
    if (body.longitude !== undefined && body.longitude !== null && Number.isFinite(body.longitude)) {
      data.longitude = body.longitude;
    }
    if (body.brandFilterMode !== undefined && (await locationTableHasBrandFilterModeColumn())) {
      data.brandFilterMode = body.brandFilterMode === 'verified_brand' ? 'verified_brand' : null;
    }
    if (body.shopifyFileGid !== undefined && (await locationTableHasShopifyFileGidColumn())) {
      (data as Record<string, unknown>).shopifyFileGid = body.shopifyFileGid ?? null;
    }

    if (await locationTableHasShopifyExclusiveUploadColumn()) {
      const imageTouched = body.imageUrl !== undefined;
      const gidTouched = body.shopifyFileGid !== undefined;
      if (imageTouched) {
        const newUrl = emptyToNull(body.imageUrl);
        const oldUrl = existing.imageUrl;
        if (newUrl === null) {
          (data as Record<string, unknown>).shopifyStoreImageExclusiveUpload = null;
          if (await locationTableHasShopifyFileGidColumn()) {
            (data as Record<string, unknown>).shopifyFileGid = null;
          }
        } else if (gidTouched) {
          (data as Record<string, unknown>).shopifyStoreImageExclusiveUpload = false;
        } else if (newUrl !== oldUrl) {
          (data as Record<string, unknown>).shopifyStoreImageExclusiveUpload = false;
        }
      } else if (gidTouched) {
        (data as Record<string, unknown>).shopifyStoreImageExclusiveUpload = false;
      }
    }

    const ex = existing as typeof existing & {
      isVerifiedDealer?: boolean | null;
      isBoutique?: boolean | null;
      isServiceCenter?: boolean | null;
    };

    const categoryTouched =
      body.isVerifiedDealer !== undefined ||
      body.isBoutique !== undefined ||
      body.isServiceCenter !== undefined ||
      body.isPremium !== undefined;

    let nextVd = Boolean(ex.isVerifiedDealer);
    let nextB = Boolean(ex.isBoutique);
    let nextSc = Boolean(ex.isServiceCenter);

    if (body.isVerifiedDealer !== undefined) nextVd = body.isVerifiedDealer;
    if (body.isBoutique !== undefined) nextB = body.isBoutique;
    if (body.isServiceCenter !== undefined) nextSc = body.isServiceCenter;
    if (body.isPremium === true && !anyPremiumCategory(nextVd, nextB, nextSc)) {
      nextVd = true;
    }
    if (body.isPremium === false) {
      nextVd = false;
      nextB = false;
      nextSc = false;
    }

    const inProgram = anyPremiumCategory(nextVd, nextB, nextSc);

    if (categoryTouched) {
      (data as Prisma.LocationUpdateInput).isVerifiedDealer = nextVd;
      (data as Prisma.LocationUpdateInput).isBoutique = nextB;
      (data as Prisma.LocationUpdateInput).isServiceCenter = nextSc;
      (data as Prisma.LocationUpdateInput).isPremium = inProgram;
    }

    const normalizedPremiumFilterBrands =
      body.premiumFilterBrands !== undefined
        ? normalizePremiumFilterBrands(body.premiumFilterBrands)
        : null;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.location.update({
          where: { handle: h },
          data,
        });
      }
      if (normalizedPremiumFilterBrands !== null) {
        await (tx as any).storePremiumBrand.deleteMany({ where: { handle: h } });
        if (normalizedPremiumFilterBrands.length > 0) {
          await (tx as any).storePremiumBrand.createMany({
            data: normalizedPremiumFilterBrands.map((brandName) => ({
              handle: h,
              brandToken: brandName.toLowerCase(),
              brandName,
            })),
            skipDuplicates: true,
          });
        }
      }
      if (categoryTouched) {
        if (inProgram) {
          await tx.premiumStore.upsert({
            where: { handle: h },
            create: {
              handle: h,
              isVerifiedDealer: nextVd,
              isBoutique: nextB,
              isServiceCenter: nextSc,
              storeType: STORE_LISTING_AD_VERIFIED,
            },
            update: {
              addedAt: new Date(),
              isVerifiedDealer: nextVd,
              isBoutique: nextB,
              isServiceCenter: nextSc,
            },
          });
        } else {
          await tx.premiumStore.deleteMany({ where: { handle: h } });
          await (tx as any).storePremiumBrand.deleteMany({ where: { handle: h } });
        }
      }
    });

    const updated = await prisma.location.findUnique({ where: { handle: h }, select: locSelect });
    if (!updated) return null;
    const premiumBrandsByHandle = await loadPremiumFilterBrandsByHandle([h]);

    if (body.imageUrl !== undefined) {
      const prevFile = managedImageFilenameFromUrl(existing.imageUrl);
      const nextUrl = emptyToNull(body.imageUrl);
      const nextFile = managedImageFilenameFromUrl(nextUrl);
      if (prevFile && prevFile !== nextFile) {
        await removeStoreImageFile(prevFile).catch(() => undefined);
      }
    }

    return toPremiumRecord(updated, premiumBrandsByHandle.get(h) ?? []);
  },

  /**
   * Save an uploaded store image file (already on disk under store-images/) and set Location.imageUrl.
   * Removes the previous managed image file when replacing.
   */
  async applyStoreImageUpload(handle: string, storedFilename: string): Promise<PremiumStoreRecord | null> {
    const h = handle.trim();
    if (!h || !isValidStoreImageFilename(storedFilename)) return null;

    const locSelect = await selectForPremiumLocationRow();
    const existing = await prisma.location.findUnique({
      where: { handle: h },
      select: locSelect,
    });
    if (!existing) return null;

    const prevFile = managedImageFilenameFromUrl(existing.imageUrl);
    const imageUrl = `${STORE_IMAGE_PUBLIC_PREFIX}${storedFilename}`;

    await prisma.location.update({
      where: { handle: h },
      data: { imageUrl },
    });

    if (prevFile && prevFile !== storedFilename) {
      await removeStoreImageFile(prevFile).catch(() => undefined);
    }

    const updated = await prisma.location.findUnique({ where: { handle: h }, select: locSelect });
    if (!updated) return null;
    const premiumBrandsByHandle = await loadPremiumFilterBrandsByHandle([h]);
    return toPremiumRecord(updated, premiumBrandsByHandle.get(h) ?? []);
  },

  /**
   * Current store image row state for Shopify cleanup decisions.
   */
  async getLocationShopifyImageRow(handle: string): Promise<{
    imageUrl: string | null;
    gid: string | null;
    exclusiveUpload: boolean | null;
  }> {
    const h = handle.trim();
    const row = await prisma.location.findUnique({
      where: { handle: h },
      select: {
        imageUrl: true,
        shopifyFileGid: true,
        shopifyStoreImageExclusiveUpload: true,
      },
    });
    if (!row) {
      return { imageUrl: null, gid: null, exclusiveUpload: null };
    }
    return {
      imageUrl: row.imageUrl,
      gid: row.shopifyFileGid,
      exclusiveUpload: row.shopifyStoreImageExclusiveUpload,
    };
  },

  async getLocationShopifyGid(handle: string): Promise<string | null> {
    const row = await this.getLocationShopifyImageRow(handle);
    return row.gid;
  },

  /**
   * Set `imageUrl` to an absolute URL (e.g. Shopify CDN) and optionally record its Shopify GID.
   * Removes a previous **local** managed file if any.
   * Pass `exclusiveShopifyUpload: true` when the file was just created via POST …/image (safe to delete from Shopify later). Omit or false for linked / shared assets.
   */
  async applyStoreImageExternalUrl(
    handle: string,
    imageUrl: string,
    fileGid?: string,
    options?: { exclusiveShopifyUpload?: boolean }
  ): Promise<PremiumStoreRecord | null> {
    const h = handle.trim();
    const url = imageUrl.trim();
    if (!h || !url.startsWith('https://')) return null;

    const locSelect = await selectForPremiumLocationRow();
    const existing = await prisma.location.findUnique({
      where: { handle: h },
      select: locSelect,
    });
    if (!existing) return null;

    const prevFile = managedImageFilenameFromUrl(existing.imageUrl);

    const updateData: Prisma.LocationUpdateInput = { imageUrl: url };
    if (fileGid !== undefined && (await locationTableHasShopifyFileGidColumn())) {
      (updateData as Record<string, unknown>).shopifyFileGid = fileGid || null;
    }
    const ex = options?.exclusiveShopifyUpload;
    if (ex !== undefined && (await locationTableHasShopifyExclusiveUploadColumn())) {
      (updateData as Record<string, unknown>).shopifyStoreImageExclusiveUpload = ex;
    }

    await prisma.location.update({
      where: { handle: h },
      data: updateData,
    });

    if (prevFile) {
      await removeStoreImageFile(prevFile).catch(() => undefined);
    }

    const updated = await prisma.location.findUnique({ where: { handle: h }, select: locSelect });
    if (!updated) return null;
    const premiumBrandsByHandle = await loadPremiumFilterBrandsByHandle([h]);
    return toPremiumRecord(updated, premiumBrandsByHandle.get(h) ?? []);
  },

  /**
   * Mark a batch of stores as premium.
   * Upserts each handle into PremiumStore and sets Location category flags.
   */
  async batchMarkPremium(entries: MarkPremiumEntry[]): Promise<{ marked: number }> {
    if (entries.length === 0) return { marked: 0 };

    for (const e of entries) {
      if (
        !e.handle?.trim() ||
        typeof e.isVerifiedDealer !== 'boolean' ||
        typeof e.isBoutique !== 'boolean' ||
        typeof e.isServiceCenter !== 'boolean'
      ) {
        throw new Error('INVALID_MARK_PREMIUM_ENTRIES');
      }
    }

    await prisma.$transaction([
      ...entries.map((e) => {
        const storeType = storeTypeFromCategoryFlags(e.isVerifiedDealer, e.isBoutique, e.isServiceCenter);
        return prisma.premiumStore.upsert({
          where: { handle: e.handle },
          update: {
            addedAt: new Date(),
            isVerifiedDealer: e.isVerifiedDealer,
            isBoutique: e.isBoutique,
            isServiceCenter: e.isServiceCenter,
            storeType,
          },
          create: {
            handle: e.handle,
            isVerifiedDealer: e.isVerifiedDealer,
            isBoutique: e.isBoutique,
            isServiceCenter: e.isServiceCenter,
            storeType,
          },
        });
      }),
      ...entries.map((e) => {
        const handle = e.handle.trim();
        const isPremium = anyPremiumCategory(e.isVerifiedDealer, e.isBoutique, e.isServiceCenter);
        return prisma.location.update({
          where: { handle },
          data: {
            isPremium,
            isVerifiedDealer: e.isVerifiedDealer,
            isBoutique: e.isBoutique,
            isServiceCenter: e.isServiceCenter,
          },
        });
      }),
    ]);

    return { marked: entries.length };
  },

  /**
   * Remove premium status from a batch of stores.
   * Deletes each handle from PremiumStore and sets Location.isPremium = false.
   */
  /** Get names of all premium locations (public — used by the map) */
  async getPremiumNames(): Promise<string[]> {
    const locations = await prisma.location.findMany({
      where: { isPremium: true },
      select: { name: true },
    });
    return locations.map((l) => l.name).filter(Boolean);
  },

  async batchRemovePremium(handles: string[]): Promise<{ removed: number }> {
    if (handles.length === 0) return { removed: 0 };

    await prisma.$transaction([
      prisma.premiumStore.deleteMany({
        where: { handle: { in: handles } },
      }),
      (prisma as any).storePremiumBrand.deleteMany({
        where: { handle: { in: handles } },
      }),
      prisma.location.updateMany({
        where: { handle: { in: handles } },
        data: {
          isPremium: false,
          isVerifiedDealer: false,
          isBoutique: false,
          isServiceCenter: false,
        },
      }),
    ]);

    return { removed: handles.length };
  },

  async deleteStoreByHandle(handle: string): Promise<{ deleted: boolean; deletedHandle: string | null }> {
    const normalized = handle.trim();
    if (!normalized) {
      return { deleted: false, deletedHandle: null };
    }
    const result = await this.deleteStoresByHandles([normalized]);
    return {
      deleted: result.deleted > 0,
      deletedHandle: result.deletedHandles[0] ?? null,
    };
  },

  async deleteStoresByHandles(handles: string[]): Promise<{ deleted: number; deletedHandles: string[] }> {
    const normalizedHandles = normalizeHandles(handles);
    if (normalizedHandles.length === 0) {
      return { deleted: 0, deletedHandles: [] };
    }

    const rows = await prisma.location.findMany({
      where: { handle: { in: normalizedHandles } },
      select: { handle: true, imageUrl: true },
    });
    if (rows.length === 0) {
      return { deleted: 0, deletedHandles: [] };
    }

    const deletedHandles = rows.map((row) => row.handle);
    const managedImageFiles = rows
      .map((row) => managedImageFilenameFromUrl(row.imageUrl))
      .filter((filename): filename is string => Boolean(filename));

    const deleteResult = await prisma.$transaction(async (tx) => {
      await (tx as any).storePremiumBrand.deleteMany({
        where: { handle: { in: deletedHandles } },
      });
      await tx.premiumStore.deleteMany({
        where: { handle: { in: deletedHandles } },
      });
      return tx.location.deleteMany({
        where: { handle: { in: deletedHandles } },
      });
    });

    if (managedImageFiles.length > 0) {
      await Promise.all(managedImageFiles.map((filename) => removeStoreImageFile(filename).catch(() => undefined)));
    }

    return {
      deleted: deleteResult.count,
      deletedHandles,
    };
  },

  /**
   * Copy category flags from `PremiumStore` to `Location` and fix `isPremium` drift.
   * Use after bulk imports or manual DB edits.
   */
  async reconcilePremiumLocationFlags(): Promise<{ setTrueCount: number; setFalseCount: number }> {
    const synced = await prisma.$executeRaw`
      UPDATE "Location" l
      SET
        "isVerifiedDealer" = ps."isVerifiedDealer",
        "isBoutique" = ps."isBoutique",
        "isServiceCenter" = ps."isServiceCenter",
        "isPremium" = (ps."isVerifiedDealer" OR ps."isBoutique" OR ps."isServiceCenter")
      FROM "PremiumStore" ps
      WHERE l.handle = ps.handle
    `;
    const setFalseCount = await prisma.$executeRaw`
      UPDATE "Location" l
      SET
        "isPremium" = false,
        "isVerifiedDealer" = false,
        "isBoutique" = false,
        "isServiceCenter" = false
      WHERE
        l."isPremium" = true
        AND NOT EXISTS (SELECT 1 FROM "PremiumStore" ps WHERE ps.handle = l.handle)
    `;
    return {
      setTrueCount: Number(synced),
      setFalseCount: Number(setFalseCount),
    };
  },

  /**
   * Ensure every categorized location is premium and has a PremiumStore registry row.
   * This is intended as an admin maintenance operation for category/isPremium drift.
   */
  async reconcilePremiumProgramFromLocationCategories(): Promise<{
    locationsPromoted: number;
    premiumStoresInserted: number;
  }> {
    return prisma.$transaction(async (tx) => {
      const categorizedWhere: Prisma.LocationWhereInput = {
        OR: [
          { isVerifiedDealer: true },
          { isBoutique: true },
          { isServiceCenter: true },
        ],
      };

      const promoted = await tx.location.updateMany({
        where: {
          ...categorizedWhere,
          isPremium: false,
        },
        data: { isPremium: true },
      });

      const categorizedLocations = await tx.location.findMany({
        where: categorizedWhere,
        select: {
          handle: true,
          isVerifiedDealer: true,
          isBoutique: true,
          isServiceCenter: true,
        },
      });

      const handles = categorizedLocations.map((row) => row.handle);
      if (handles.length === 0) {
        return {
          locationsPromoted: promoted.count,
          premiumStoresInserted: 0,
        };
      }

      const existingPremiumRows = await tx.premiumStore.findMany({
        where: { handle: { in: handles } },
        select: { handle: true },
      });
      const existingHandles = new Set(existingPremiumRows.map((row) => row.handle));

      const rowsToInsert = categorizedLocations
        .filter((row) => !existingHandles.has(row.handle))
        .map((row) => ({
          handle: row.handle,
          isVerifiedDealer: row.isVerifiedDealer,
          isBoutique: row.isBoutique,
          isServiceCenter: row.isServiceCenter,
        }));

      if (rowsToInsert.length === 0) {
        return {
          locationsPromoted: promoted.count,
          premiumStoresInserted: 0,
        };
      }

      const inserted = await tx.premiumStore.createMany({
        data: rowsToInsert,
        skipDuplicates: true,
      });

      return {
        locationsPromoted: promoted.count,
        premiumStoresInserted: inserted.count,
      };
    });
  },

  /**
   * Merge `otherHandles` into `keepHandle`: union brands/customBrands/tags on the server,
   * apply admin-chosen `mergedStore` fields, OR category flags, delete loser rows.
   */
  async mergeStoresManual(input: {
    keepHandle: string;
    otherHandles: string[];
    mergedStore: ManualMergeMergedStorePayload;
  }): Promise<PremiumStoreRecord> {
    const keepHandle = input.keepHandle.trim();
    const otherUnique = [...new Set(input.otherHandles.map((h) => h.trim()).filter(Boolean))];
    if (!keepHandle || otherUnique.length === 0) {
      throw new Error('MERGE_INVALID_BODY');
    }
    if (otherUnique.includes(keepHandle)) {
      throw new Error('MERGE_INVALID_BODY');
    }
    const allHandles = [keepHandle, ...otherUnique];
    if (allHandles.length > MERGE_MANUAL_MAX_STORES) {
      throw new Error('MERGE_TOO_MANY');
    }
    assertValidMergeCoords(input.mergedStore.latitude, input.mergedStore.longitude);

    const mergeSelect = {
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
      isVerifiedDealer: true,
      isBoutique: true,
      isServiceCenter: true,
    } as const;

    const rows = await prisma.location.findMany({
      where: { handle: { in: allHandles } },
      select: mergeSelect,
    });
    if (rows.length !== allHandles.length) {
      throw new Error('MERGE_STORE_NOT_FOUND');
    }

    const survivor = rows.find((r) => r.handle === keepHandle);
    if (!survivor) {
      throw new Error('MERGE_STORE_NOT_FOUND');
    }
    const others = rows.filter((r) => r.handle !== keepHandle);
    if (others.length !== otherUnique.length) {
      throw new Error('MERGE_STORE_NOT_FOUND');
    }

    const toMergeRow = (r: (typeof rows)[number]): MergeStoreRow => ({
      handle: r.handle,
      name: r.name,
      brands: r.brands,
      customBrands: r.customBrands,
      tags: r.tags,
      addressLine1: r.addressLine1,
      city: r.city,
      country: r.country,
      latitude: r.latitude,
      longitude: r.longitude,
      isPremium: r.isPremium,
      updatedAt: r.updatedAt,
    });

    const plan = buildManualMergePlan(toMergeRow(survivor), others.map(toMergeRow));
    const loserHandles = plan.remove.map((r) => r.handle);

    const vd = rows.some((r) => Boolean(r.isVerifiedDealer));
    const bt = rows.some((r) => Boolean(r.isBoutique));
    const sc = rows.some((r) => Boolean(r.isServiceCenter));
    const wasPremium = rows.some((r) => Boolean(r.isPremium));
    const inProgram = wasPremium || vd || bt || sc;

    const premRows = await prisma.premiumStore.findMany({
      where: { handle: { in: allHandles } },
    });
    const mergedPremiumBrandRows = await (prisma as any).storePremiumBrand.findMany({
      where: { handle: { in: allHandles } },
      select: { brandName: true },
    });
    const mergedPremiumBrandNames = normalizePremiumFilterBrands(
      mergedPremiumBrandRows.map((row: { brandName: string }) => row.brandName)
    );
    const survivorPrem = premRows.find((p) => p.handle === keepHandle);
    const loserNotes = premRows
      .filter((p) => loserHandles.includes(p.handle))
      .map((p) => p.notes?.trim())
      .filter(Boolean) as string[];
    const mergedNotes = mergePremiumNotesParts(survivorPrem?.notes, ...loserNotes);

    const ms = input.mergedStore;
    const nextCountry = normalizeCountry(ms.country.trim()) || ms.country.trim();
    const phoneNorm = normalizePhone(ms.phone, nextCountry);
    const brandsFinal = normalizeBrandsCsvField(plan.mergedBrands) ?? null;

    const locSelect = await selectForPremiumLocationRow();

    await prisma.$transaction(async (tx) => {
      await tx.premiumStore.deleteMany({ where: { handle: { in: loserHandles } } });
      await (tx as any).storePremiumBrand.deleteMany({ where: { handle: { in: loserHandles } } });

      await tx.location.update({
        where: { handle: keepHandle },
        data: {
          name: ms.name.trim() || survivor.name,
          nameEn: emptyToNull(ms.nameEn),
          addressLine1: ms.addressLine1.trim() || survivor.addressLine1,
          addressLine1En: emptyToNull(ms.addressLine1En),
          addressLine2: emptyToNull(ms.addressLine2),
          city: ms.city.trim() || survivor.city,
          cityEn: emptyToNull(ms.cityEn),
          stateProvinceRegion: emptyToNull(ms.stateProvinceRegion),
          postalCode: emptyToNull(ms.postalCode),
          country: nextCountry,
          phone: phoneNorm,
          website: emptyToNull(ms.website),
          latitude: ms.latitude,
          longitude: ms.longitude,
          brands: brandsFinal,
          customBrands: plan.mergedCustomBrands,
          tags: plan.mergedTags,
          isVerifiedDealer: vd,
          isBoutique: bt,
          isServiceCenter: sc,
          isPremium: inProgram,
        },
      });

      if (inProgram) {
        await tx.premiumStore.upsert({
          where: { handle: keepHandle },
          create: {
            handle: keepHandle,
            isVerifiedDealer: vd,
            isBoutique: bt,
            isServiceCenter: sc,
            storeType: STORE_LISTING_AD_VERIFIED,
            notes: mergedNotes ?? null,
          },
          update: {
            addedAt: new Date(),
            isVerifiedDealer: vd,
            isBoutique: bt,
            isServiceCenter: sc,
            notes: mergedNotes ?? null,
          },
        });
      } else {
        await tx.premiumStore.deleteMany({ where: { handle: keepHandle } });
        await (tx as any).storePremiumBrand.deleteMany({ where: { handle: keepHandle } });
      }

      if (inProgram) {
        await (tx as any).storePremiumBrand.deleteMany({ where: { handle: keepHandle } });
        if (mergedPremiumBrandNames.length > 0) {
          await (tx as any).storePremiumBrand.createMany({
            data: mergedPremiumBrandNames.map((brandName) => ({
              handle: keepHandle,
              brandToken: brandName.toLowerCase(),
              brandName,
            })),
            skipDuplicates: true,
          });
        }
      }

      await tx.location.deleteMany({ where: { handle: { in: loserHandles } } });
    });

    const updated = await prisma.location.findUnique({
      where: { handle: keepHandle },
      select: locSelect,
    });
    if (!updated) {
      throw new Error('MERGE_STORE_NOT_FOUND');
    }
    const premiumBrandsByHandle = await loadPremiumFilterBrandsByHandle([keepHandle]);
    return toPremiumRecord(updated, premiumBrandsByHandle.get(keepHandle) ?? []);
  },
};
