import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const {
  deleteStoreByHandle,
  deleteStoresByHandles,
  batchRemovePremium,
} = vi.hoisted(() => ({
  deleteStoreByHandle: vi.fn(),
  deleteStoresByHandles: vi.fn(),
  batchRemovePremium: vi.fn(),
}));

vi.mock('../../middleware/auth.middleware', () => ({
  authenticate: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../../services/premium.service', () => ({
  MERGE_MANUAL_MAX_STORES: 25,
  parseManualMergeBody: vi.fn(),
  premiumService: {
    deleteStoreByHandle,
    deleteStoresByHandles,
    batchRemovePremium,
    getPremiumNames: vi.fn(),
    getStores: vi.fn(),
    mergeStoresManual: vi.fn(),
    updateStoreByHandle: vi.fn(),
    applyStoreImageUpload: vi.fn(),
    applyStoreImageExternalUrl: vi.fn(),
    batchMarkPremium: vi.fn(),
    reconcilePremiumLocationFlags: vi.fn(),
    reconcilePremiumProgramFromLocationCategories: vi.fn(),
  },
}));

import premiumRoutes from '../../routes/premium.routes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/premium-stores', premiumRoutes);
  return app;
}

describe('Premium Routes Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DELETE /api/premium-stores/stores/:handle deletes one store', async () => {
    const app = createApp();
    deleteStoreByHandle.mockResolvedValue({ deleted: true, deletedHandle: 'h1' });

    const res = await request(app).delete('/api/premium-stores/stores/h1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, deletedHandle: 'h1' });
    expect(deleteStoreByHandle).toHaveBeenCalledWith('h1');
  });

  it('DELETE /api/premium-stores/stores uses permanent delete mode for bulk handles', async () => {
    const app = createApp();
    deleteStoresByHandles.mockResolvedValue({ deleted: 2, deletedHandles: ['h1', 'h2'] });

    const res = await request(app)
      .delete('/api/premium-stores/stores')
      .send({ handles: ['h1', 'h2'], mode: 'delete-from-db' });

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(res.body.deletedHandles).toEqual(['h1', 'h2']);
    expect(deleteStoresByHandles).toHaveBeenCalledWith(['h1', 'h2']);
  });

  it('DELETE /api/premium-stores/stores returns 400 for invalid handle payload', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/premium-stores/stores').send({ handles: [] });
    expect(res.status).toBe(400);
  });
});
