import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  findUnique,
  findMany,
  $transaction,
  $executeRaw,
  premiumFindUnique,
  premiumUpsert,
  locationUpdateMany,
  locationUpdate,
  locationDeleteMany,
  premiumDeleteMany,
  premiumBrandFindMany,
  premiumBrandDeleteMany,
  premiumBrandCreateMany,
} = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  $transaction: vi.fn(),
  $executeRaw: vi.fn(),
  premiumFindUnique: vi.fn(),
  premiumUpsert: vi.fn(),
  locationUpdateMany: vi.fn(),
  locationUpdate: vi.fn(),
  locationDeleteMany: vi.fn(),
  premiumDeleteMany: vi.fn(),
  premiumBrandFindMany: vi.fn(),
  premiumBrandDeleteMany: vi.fn(),
  premiumBrandCreateMany: vi.fn(),
}));

vi.mock('../../utils/location-brand-filter-column', () => ({
  locationTableHasBrandFilterModeColumn: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    location: {
      findUnique,
      findMany,
      updateMany: locationUpdateMany,
      update: locationUpdate,
      deleteMany: locationDeleteMany,
    },
    $transaction,
    $executeRaw,
    premiumStore: {
      findUnique: premiumFindUnique,
      upsert: premiumUpsert,
      deleteMany: premiumDeleteMany,
    },
    storePremiumBrand: {
      findMany: premiumBrandFindMany,
      deleteMany: premiumBrandDeleteMany,
      createMany: premiumBrandCreateMany,
    },
  },
}));

import { parseManualMergeBody, premiumService } from '../../services/premium.service';

const baseRow = {
  handle: 'h1',
  name: 'Test Store',
  nameEn: null as string | null,
  addressLine1: '1 Main St',
  addressLine1En: null as string | null,
  addressLine2: null as string | null,
  city: 'NYC',
  cityEn: null as string | null,
  stateProvinceRegion: 'NY' as string | null,
  country: 'United States',
  postalCode: '10001' as string | null,
  latitude: 40.7128,
  longitude: -74.006,
  phone: '+12025550123' as string | null,
  brands: null as string | null,
  customBrands: null as string | null,
  isPremium: false,
  isVerifiedDealer: false,
  isBoutique: false,
  isServiceCenter: false,
  website: null as string | null,
  imageUrl: null as string | null,
  pageDescription: null as string | null,
  monday: null as string | null,
  tuesday: null as string | null,
  wednesday: null as string | null,
  thursday: null as string | null,
  friday: null as string | null,
  saturday: null as string | null,
  sunday: null as string | null,
  brandFilterMode: null as string | null,
};

describe('premiumService.updateStoreByHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    premiumBrandFindMany.mockResolvedValue([]);
    premiumBrandDeleteMany.mockResolvedValue({ count: 0 });
    premiumBrandCreateMany.mockResolvedValue({ count: 0 });
  });

  it('returns null for blank handle', async () => {
    const r = await premiumService.updateStoreByHandle('  ', { city: 'X' });
    expect(r).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when location is missing', async () => {
    findUnique.mockResolvedValueOnce(null);
    const r = await premiumService.updateStoreByHandle('missing', { city: 'X' });
    expect(r).toBeNull();
    expect(findUnique).toHaveBeenCalledWith({
      where: { handle: 'missing' },
      select: expect.any(Object),
    });
  });

  it('runs transaction with premium upsert and location update when marking premium', async () => {
    const txPremiumUpsert = vi.fn().mockResolvedValue(undefined);
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow })
      .mockResolvedValueOnce({ ...baseRow, isPremium: true });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: txPremiumUpsert,
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    const result = await premiumService.updateStoreByHandle('h1', {
      isPremium: true,
      isServiceCenter: false,
    });

    expect(txPremiumUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { handle: 'h1' },
        create: expect.objectContaining({
          handle: 'h1',
          isVerifiedDealer: true,
          isBoutique: false,
          isServiceCenter: false,
          storeType: 'AD Verified',
        }),
      })
    );
    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({
        isPremium: true,
        isVerifiedDealer: true,
        isBoutique: false,
        isServiceCenter: false,
      }),
    });
    expect(result?.isPremium).toBe(true);
  });

  it('deletes premium row and sets isPremium false when unmarking', async () => {
    const txDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow, isPremium: true })
      .mockResolvedValueOnce({ ...baseRow, isPremium: false });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: vi.fn(),
          deleteMany: txDeleteMany,
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    await premiumService.updateStoreByHandle('h1', { isPremium: false });

    expect(txDeleteMany).toHaveBeenCalledWith({ where: { handle: 'h1' } });
    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({
        isPremium: false,
        isVerifiedDealer: false,
        isBoutique: false,
        isServiceCenter: false,
      }),
    });
  });

  it('updates brandFilterMode on Location without a PremiumStore row', async () => {
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow })
      .mockResolvedValueOnce({ ...baseRow, brandFilterMode: 'verified_brand' });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    const result = await premiumService.updateStoreByHandle('h1', {
      brandFilterMode: 'verified_brand',
    });

    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({ brandFilterMode: 'verified_brand' }),
    });
    expect(result?.brandFilterMode).toBe('verified_brand');
  });

  it('persists premium filter brands as normalized rows per handle', async () => {
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);
    const txPremiumBrandDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const txPremiumBrandCreateMany = vi.fn().mockResolvedValue({ count: 2 });

    findUnique
      .mockResolvedValueOnce({ ...baseRow })
      .mockResolvedValueOnce({ ...baseRow });

    premiumBrandFindMany.mockResolvedValueOnce([
      { handle: 'h1', brandName: 'OMEGA' },
      { handle: 'h1', brandName: 'ROLEX' },
    ]);

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: txPremiumBrandDeleteMany,
          createMany: txPremiumBrandCreateMany,
        },
        location: { update: txLocationUpdate },
      });
    });

    const result = await premiumService.updateStoreByHandle('h1', {
      premiumFilterBrands: ['omega_stores', 'ROLEX', 'Omega'],
    });

    expect(txPremiumBrandDeleteMany).toHaveBeenCalledWith({ where: { handle: 'h1' } });
    expect(txPremiumBrandCreateMany).toHaveBeenCalledWith({
      data: [
        { handle: 'h1', brandToken: 'omega', brandName: 'OMEGA' },
        { handle: 'h1', brandToken: 'rolex', brandName: 'ROLEX' },
      ],
      skipDuplicates: true,
    });
    expect(result?.premiumFilterBrands).toEqual(['OMEGA', 'ROLEX']);
  });

  it('upserts PremiumStore when isServiceCenter is set without prior registry (joins program)', async () => {
    const txPremiumUpsert = vi.fn().mockResolvedValue(undefined);
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow })
      .mockResolvedValueOnce({ ...baseRow, isServiceCenter: true, isPremium: true, isVerifiedDealer: false, isBoutique: false });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: txPremiumUpsert,
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    await premiumService.updateStoreByHandle('h1', { isServiceCenter: true });

    expect(txPremiumUpsert).toHaveBeenCalled();
    expect(txLocationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { handle: 'h1' },
        data: expect.objectContaining({ isServiceCenter: true, isPremium: true }),
      })
    );
  });

  it('updates website without premium ops when isPremium omitted', async () => {
    const txPremiumUpsert = vi.fn();
    const txDeleteMany = vi.fn();
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow })
      .mockResolvedValueOnce({ ...baseRow, website: 'https://example.com' });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: txPremiumUpsert,
          deleteMany: txDeleteMany,
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    await premiumService.updateStoreByHandle('h1', { website: 'https://example.com' });

    expect(txPremiumUpsert).not.toHaveBeenCalled();
    expect(txDeleteMany).not.toHaveBeenCalled();
    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({ website: 'https://example.com' }),
    });
  });

  it('updates brands CSV on Location when brands is provided', async () => {
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow, brands: 'OMEGA' })
      .mockResolvedValueOnce({ ...baseRow, brands: 'OMEGA, ROLEX' });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    const result = await premiumService.updateStoreByHandle('h1', {
      brands: 'OMEGA, ROLEX',
    });

    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({ brands: 'OMEGA, ROLEX' }),
    });
    expect(result?.brands).toBe('OMEGA, ROLEX');
  });

  it('clears brands when brands is null', async () => {
    const txLocationUpdate = vi.fn().mockResolvedValue(undefined);

    findUnique
      .mockResolvedValueOnce({ ...baseRow, brands: 'OMEGA' })
      .mockResolvedValueOnce({ ...baseRow, brands: null });

    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      await fn({
        premiumStore: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        storePremiumBrand: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        location: { update: txLocationUpdate },
      });
    });

    await premiumService.updateStoreByHandle('h1', { brands: null });

    expect(txLocationUpdate).toHaveBeenCalledWith({
      where: { handle: 'h1' },
      data: expect.objectContaining({ brands: null }),
    });
  });
});

describe('premiumService.batchMarkPremium / batchRemovePremium', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    premiumUpsert.mockResolvedValue({});
    locationUpdate.mockResolvedValue({});
    locationUpdateMany.mockResolvedValue({ count: 2 });
    premiumDeleteMany.mockResolvedValue({ count: 1 });
    premiumBrandDeleteMany.mockResolvedValue({ count: 0 });
  });

  it('batchMarkPremium runs array transaction with upserts and per-handle location updates', async () => {
    $transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg as Promise<unknown>[]) : Promise.resolve()
    );

    const r = await premiumService.batchMarkPremium([
      { handle: 'a', isVerifiedDealer: false, isBoutique: false, isServiceCenter: true },
      { handle: 'b', isVerifiedDealer: false, isBoutique: false, isServiceCenter: false },
    ]);

    expect(r.marked).toBe(2);
    expect(premiumUpsert).toHaveBeenCalledTimes(2);
    expect(premiumUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { handle: 'a' },
        create: expect.objectContaining({
          handle: 'a',
          isVerifiedDealer: false,
          isBoutique: false,
          isServiceCenter: true,
          storeType: 'Service center',
        }),
      })
    );
    expect(locationUpdate).toHaveBeenCalledTimes(2);
    expect(locationUpdate).toHaveBeenCalledWith({
      where: { handle: 'a' },
      data: {
        isPremium: true,
        isVerifiedDealer: false,
        isBoutique: false,
        isServiceCenter: true,
      },
    });
  });

  it('batchMarkPremium throws on invalid entry', async () => {
    await expect(
      premiumService.batchMarkPremium([
        // @ts-expect-error exercise runtime validation
        { handle: '  ', isServiceCenter: true },
      ])
    ).rejects.toThrow('INVALID_MARK_PREMIUM_ENTRIES');
  });

  it('batchRemovePremium deletes registry rows and clears isPremium', async () => {
    $transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg as Promise<unknown>[]) : Promise.resolve()
    );

    const r = await premiumService.batchRemovePremium(['x']);

    expect(r.removed).toBe(1);
    expect(premiumDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['x'] } } });
    expect(premiumBrandDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['x'] } } });
    expect(locationUpdateMany).toHaveBeenCalledWith({
      where: { handle: { in: ['x'] } },
      data: {
        isPremium: false,
        isVerifiedDealer: false,
        isBoutique: false,
        isServiceCenter: false,
      },
    });
  });
});

describe('premiumService.deleteStoreByHandle / deleteStoresByHandles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    premiumDeleteMany.mockResolvedValue({ count: 1 });
    premiumBrandDeleteMany.mockResolvedValue({ count: 1 });
    locationDeleteMany.mockResolvedValue({ count: 1 });
    findMany.mockResolvedValue([{ handle: 'h1', imageUrl: null }]);
  });

  it('deletes a single store and related premium rows', async () => {
    const txPremiumDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const txBrandDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const txLocationDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<{ count: number }>) =>
      fn({
        premiumStore: { deleteMany: txPremiumDeleteMany },
        storePremiumBrand: { deleteMany: txBrandDeleteMany },
        location: { deleteMany: txLocationDeleteMany },
      })
    );

    const result = await premiumService.deleteStoreByHandle('h1');

    expect(result).toEqual({ deleted: true, deletedHandle: 'h1' });
    expect(txBrandDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['h1'] } } });
    expect(txPremiumDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['h1'] } } });
    expect(txLocationDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['h1'] } } });
  });

  it('deletes multiple stores in one transaction', async () => {
    const txPremiumDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const txBrandDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    const txLocationDeleteMany = vi.fn().mockResolvedValue({ count: 2 });
    findMany.mockResolvedValue([
      { handle: 'h1', imageUrl: null },
      { handle: 'h2', imageUrl: null },
    ]);
    $transaction.mockImplementation(async (fn: (tx: unknown) => Promise<{ count: number }>) =>
      fn({
        premiumStore: { deleteMany: txPremiumDeleteMany },
        storePremiumBrand: { deleteMany: txBrandDeleteMany },
        location: { deleteMany: txLocationDeleteMany },
      })
    );

    const result = await premiumService.deleteStoresByHandles(['h1', 'h2']);

    expect(result).toEqual({ deleted: 2, deletedHandles: ['h1', 'h2'] });
    expect(txLocationDeleteMany).toHaveBeenCalledWith({ where: { handle: { in: ['h1', 'h2'] } } });
  });

  it('returns no-op for unknown handles', async () => {
    findMany.mockResolvedValue([]);
    const result = await premiumService.deleteStoresByHandles(['missing']);
    expect(result).toEqual({ deleted: 0, deletedHandles: [] });
    expect($transaction).not.toHaveBeenCalled();
  });
});

describe('parseManualMergeBody', () => {
  it('parses a valid body', () => {
    const r = parseManualMergeBody({
      keepHandle: ' a ',
      otherHandles: ['b', 'c'],
      mergedStore: {
        name: 'N',
        nameEn: null,
        addressLine1: '1 St',
        addressLine1En: null,
        addressLine2: null,
        city: 'C',
        cityEn: null,
        stateProvinceRegion: null,
        postalCode: null,
        country: 'US',
        phone: null,
        website: null,
        latitude: 40,
        longitude: -74,
      },
    });
    expect(r.keepHandle).toBe('a');
    expect(r.otherHandles).toEqual(['b', 'c']);
    expect(r.mergedStore.latitude).toBe(40);
    expect(r.mergedStore.nameEn).toBeNull();
  });

  it('throws MERGE_INVALID_BODY for bad otherHandles', () => {
    expect(() =>
      parseManualMergeBody({
        keepHandle: 'a',
        otherHandles: [],
        mergedStore: {},
      })
    ).toThrow('MERGE_INVALID_BODY');
  });

  it('throws MERGE_INVALID_COORDS for out-of-range latitude', () => {
    expect(() =>
      parseManualMergeBody({
        keepHandle: 'a',
        otherHandles: ['b'],
        mergedStore: {
          name: 'N',
          addressLine1: '1',
          city: 'C',
          country: 'US',
          latitude: 91,
          longitude: 0,
        },
      })
    ).toThrow('MERGE_INVALID_COORDS');
  });
});

describe('premiumService.reconcilePremiumLocationFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    $executeRaw.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
  });

  it('runs two raw updates and returns counts', async () => {
    const r = await premiumService.reconcilePremiumLocationFlags();
    expect(r).toEqual({ setTrueCount: 2, setFalseCount: 1 });
    expect($executeRaw).toHaveBeenCalledTimes(2);
  });
});
