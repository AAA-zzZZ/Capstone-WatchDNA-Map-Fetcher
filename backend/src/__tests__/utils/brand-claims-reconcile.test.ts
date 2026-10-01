import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMocks = vi.hoisted(() => ({
  findManyFn: vi.fn(),
  updateFn: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../lib/prisma', () => ({
  default: {
    location: {
      findMany: (...args: unknown[]) => prismaMocks.findManyFn(...args),
      update: (...args: unknown[]) => prismaMocks.updateFn(...args),
    },
  },
}));

import { reconcileBrandClaims, formatBrandReconcileLog } from '../../utils/brand-claims-reconcile';

const claimant = (handle: string, name: string, brands: string) => ({
  handle,
  name,
  brands,
  city: 'Calgary',
  country: 'Canada',
});

beforeEach(() => {
  vi.clearAllMocks();
  prismaMocks.updateFn.mockResolvedValue({});
});

describe('reconcileBrandClaims', () => {
  it('reports stale claimants the feed did not match, and applies on execute', async () => {
    prismaMocks.findManyFn.mockResolvedValue([
      claimant('h1', 'Maison Birks', 'ROLEX, OMEGA'),
      claimant('h2', "Maggie's Diamond Boutique", 'ROLEX, TISSOT, RADO'),
    ]);

    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(['h1']),
      feedRows: 100,
      execute: true,
    });

    expect(report.claimants).toBe(2);
    expect(report.confirmed).toBe(1);
    expect(report.stale).toHaveLength(1);
    expect(report.stale[0]).toMatchObject({ handle: 'h2', brandsAfter: 'TISSOT, RADO' });
    expect(report.applied).toBe(true);
    expect(prismaMocks.updateFn).toHaveBeenCalledTimes(1);
    expect(prismaMocks.updateFn.mock.calls[0][0]).toEqual({
      where: { handle: 'h2' },
      data: { brands: 'TISSOT, RADO' },
    });
  });

  it('counts stored spelling variants of the brand as claims', async () => {
    prismaMocks.findManyFn.mockResolvedValue([claimant('h1', 'Right Time', 'BALL WATCH, SEIKO')]);
    const report = await reconcileBrandClaims({
      brand: 'BALL',
      matchedHandles: new Set(),
      feedRows: 50,
      execute: false,
    });
    expect(report.claimants).toBe(1);
    expect(report.stale[0]!.brandsAfter).toBe('SEIKO');
  });

  it('report-only mode never writes', async () => {
    prismaMocks.findManyFn.mockResolvedValue([claimant('h2', 'Store', 'ROLEX')]);
    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(['other']),
      feedRows: 100,
      execute: false,
    });
    expect(report.stale).toHaveLength(1);
    expect(report.applied).toBe(false);
    expect(prismaMocks.updateFn).not.toHaveBeenCalled();
  });

  it('guards block apply on tiny feeds even with execute', async () => {
    prismaMocks.findManyFn.mockResolvedValue([claimant('h2', 'Store', 'ROLEX')]);
    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(),
      feedRows: 3,
      execute: true,
    });
    expect(report.guard).toContain('partial scrape');
    expect(report.applied).toBe(false);
    expect(prismaMocks.updateFn).not.toHaveBeenCalled();
  });

  it('guards block apply when the feed confirms no claimants', async () => {
    prismaMocks.findManyFn.mockResolvedValue([
      claimant('h1', 'A', 'ROLEX'),
      claimant('h2', 'B', 'ROLEX'),
    ]);
    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(['unrelated']),
      feedRows: 100,
      execute: true,
    });
    expect(report.guard).toContain('confirmed none');
    expect(report.applied).toBe(false);
    expect(prismaMocks.updateFn).not.toHaveBeenCalled();
  });

  it('force overrides guards', async () => {
    prismaMocks.findManyFn.mockResolvedValue([claimant('h2', 'Store', 'ROLEX, OMEGA')]);
    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(),
      feedRows: 1,
      execute: true,
      force: true,
    });
    expect(report.guard).toBeUndefined();
    expect(report.applied).toBe(true);
    expect(prismaMocks.updateFn).toHaveBeenCalledTimes(1);
  });
});

describe('formatBrandReconcileLog', () => {
  it('renders counts, guard, and apply status', async () => {
    prismaMocks.findManyFn.mockResolvedValue([claimant('h2', 'Store', 'ROLEX')]);
    const report = await reconcileBrandClaims({
      brand: 'ROLEX',
      matchedHandles: new Set(),
      feedRows: 3,
      execute: true,
    });
    const log = formatBrandReconcileLog(report);
    expect(log).toContain('BRAND CLAIM RECONCILE (ROLEX)');
    expect(log).toContain('stale: 1');
    expect(log).toContain('Guard blocked apply');
    expect(log).toContain('Report only');
  });
});
