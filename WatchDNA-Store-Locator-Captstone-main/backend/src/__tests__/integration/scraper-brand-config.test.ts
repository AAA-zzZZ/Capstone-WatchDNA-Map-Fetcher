import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import scraperRoutes from '../../routes/scraper.routes';
import { brandConfigIdToDisplayName } from '../../utils/brand-display-name';

const mockedState = vi.hoisted(() => ({
  configs: {
    _README: { note: 'baseline readme' },
    omega_stores: {
      type: 'json',
      url: 'https://example.test/omega',
      description: 'Baseline Omega endpoint',
      enabled: true,
    },
  } as Record<string, any>,
}));

vi.mock('../../services/brand-config.service', () => ({
  loadMergedBrandConfigs: vi.fn(async () => ({ ...mockedState.configs })),
  upsertBrandConfigRow: vi.fn(async (brandId: string, data: Record<string, any>) => {
    mockedState.configs[brandId] = data;
  }),
  applyBrandRename: vi.fn(async (oldBrandId: string) => {
    delete mockedState.configs[oldBrandId];
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/scraper', scraperRoutes);
  return app;
}

describe('Scraper Brand Config Integration', () => {
  beforeEach(() => {
    mockedState.configs = {
      _README: { note: 'baseline readme' },
      omega_stores: {
        type: 'json',
        url: 'https://example.test/omega',
        description: 'Baseline Omega endpoint',
        enabled: true,
      },
    };
    vi.clearAllMocks();
  });

  it('saves a manually entered brand config', async () => {
    const app = createApp();
    const response = await request(app).post('/api/scraper/brands').send({
      brandId: 'manual_labs_stores',
      brandName: 'Manual Labs',
      endpoint: {
        url: 'https://example.test/manual-labs/stores',
        type: 'json',
        data_path: 'stores',
        field_mapping: { name: 'name', address: 'address' },
      },
      suggestedConfig: {
        method: 'GET',
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.brandId).toBe('manual_labs_stores');
    expect(response.body.config.url).toBe('https://example.test/manual-labs/stores');
    expect(response.body.config.display_name).toBe('Manual Labs');
  });

  it('adds manual brand to available scraping runs list', async () => {
    const app = createApp();
    await request(app).post('/api/scraper/brands').send({
      brandId: 'manual_labs_stores',
      brandName: 'Manual Labs',
      endpoint: {
        url: 'https://example.test/manual-labs/stores',
        type: 'json',
      },
    });

    const brandsResponse = await request(app).get('/api/scraper/brands');
    expect(brandsResponse.status).toBe(200);
    expect(brandsResponse.body.brands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'manual_labs_stores',
          name: 'Manual Labs',
          type: 'json',
        }),
      ])
    );
  });

  it('normalizes newly added brand IDs into project-wide display names', () => {
    expect(brandConfigIdToDisplayName('manual_labs_stores')).toBe('MANUAL LABS');
    expect(brandConfigIdToDisplayName('north_star_watches')).toBe('NORTH STAR');
  });

  it('returns conflict when overwrite is false and brand already exists', async () => {
    const app = createApp();
    mockedState.configs.manual_labs_stores = {
      type: 'json',
      url: 'https://example.test/manual-labs/old',
      description: 'Old config',
      enabled: true,
    };

    const response = await request(app).post('/api/scraper/brands').send({
      brandId: 'manual_labs_stores',
      brandName: 'Manual Labs',
      endpoint: {
        url: 'https://example.test/manual-labs/new',
        type: 'json',
      },
      overwrite: false,
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain('already exists');
    expect(response.body.existingConfig.url).toBe('https://example.test/manual-labs/old');
  });

  it('uses display_name verbatim in the brands list for filter labels', async () => {
    const app = createApp();
    await request(app).post('/api/scraper/brands').send({
      brandId: 'rolex_dealers',
      brandName: 'Rolex Authorized Dealers',
      endpoint: { url: 'https://example.test/rolex', type: 'json' },
    });

    const brandsResponse = await request(app).get('/api/scraper/brands');
    const brand = brandsResponse.body.brands.find((b: any) => b.id === 'rolex_dealers');
    expect(brand).toBeDefined();
    expect(brand.name).toBe('Rolex Authorized Dealers');
  });

  it('updates existing config when overwrite is true', async () => {
    const app = createApp();
    mockedState.configs.manual_labs_stores = {
      type: 'json',
      url: 'https://example.test/manual-labs/old',
      description: 'Old config',
      enabled: true,
    };

    const response = await request(app).post('/api/scraper/brands').send({
      brandId: 'manual_labs_stores',
      brandName: 'Manual Labs Updated',
      endpoint: {
        url: 'https://example.test/manual-labs/new',
        type: 'json',
      },
      overwrite: true,
    });

    expect(response.status).toBe(200);
    expect(response.body.config.url).toBe('https://example.test/manual-labs/new');
    expect(response.body.config.display_name).toBe('Manual Labs Updated');
  });

  // -------------------------------------------------------------------------
  // Probe-output → save → list pipeline tests
  // These simulate saving a config that was built from real probe output
  // (the same shape that probe_endpoint.py returns and the frontend submits).
  // -------------------------------------------------------------------------

  describe('probe output → save → list pipeline', () => {
    // Mirrors a real Stockist (Bremont-style) probe result
    const bremonProbeOutput = {
      url: 'https://stockist.co/api/v1/u3131/locations/all',
      type: 'json',
      confidence: 0.9,
      verified: true,
      verified_store_count: 189,
      store_count: 189,
      data_path: '',
      field_mapping: {
        name: 'name',
        city: 'city',
        state: 'state',
        postal_code: 'postal_code',
        country: 'country',
        latitude: 'latitude',
        longitude: 'longitude',
        phone: 'phone',
        website: 'website',
      },
      method: 'GET',
    };

    // Mirrors a real StoreMapper (Mondaine-style) probe result
    const mondaineProbeOutput = {
      url: 'https://storemapper.co/api/users/6698/stores.json',
      type: 'json',
      confidence: 0.9,
      verified: true,
      verified_store_count: 1310,
      store_count: 1310,
      data_path: 'stores',
      field_mapping: {
        name: 'name',
        address: 'address',
        latitude: 'latitude',
        longitude: 'longitude',
        phone: 'phone',
        website: 'url',
      },
      method: 'GET',
    };

    it('saves probe output and all fields are persisted in the config', async () => {
      const app = createApp();
      const res = await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: bremonProbeOutput,
      });

      expect(res.status).toBe(200);
      expect(res.body.brandId).toBe('bremont_watches');
      const cfg = res.body.config;
      expect(cfg.url).toBe(bremonProbeOutput.url);
      expect(cfg.type).toBe('json');
      // Empty data_path means root-level array — the key is intentionally omitted.
      expect(cfg.data_path == null || cfg.data_path === '').toBe(true);
      expect(cfg.field_mapping).toMatchObject({ name: 'name', latitude: 'latitude' });
      expect(cfg.display_name).toBe('BREMONT');
    });

    it('saved probe config appears in the brands list with correct name and type', async () => {
      const app = createApp();
      await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: bremonProbeOutput,
      });

      const listRes = await request(app).get('/api/scraper/brands');
      expect(listRes.status).toBe(200);
      const brand = listRes.body.brands.find((b: any) => b.id === 'bremont_watches');
      expect(brand).toBeDefined();
      expect(brand.name).toBe('BREMONT');
      expect(brand.type).toBe('json');
      expect(brand.url).toBe(bremonProbeOutput.url);
    });

    it('saves nested data_path from probe output and lists correctly', async () => {
      const app = createApp();
      await request(app).post('/api/scraper/brands').send({
        brandId: 'mondaine_stores',
        brandName: 'MONDAINE',
        endpoint: mondaineProbeOutput,
      });

      const listRes = await request(app).get('/api/scraper/brands');
      const brand = listRes.body.brands.find((b: any) => b.id === 'mondaine_stores');
      expect(brand).toBeDefined();
      expect(brand.name).toBe('MONDAINE');

      // Verify the stored config preserved the data_path
      expect(mockedState.configs['mondaine_stores'].data_path).toBe('stores');
    });

    it('two different probed brands are independently listed', async () => {
      const app = createApp();
      await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: bremonProbeOutput,
      });
      await request(app).post('/api/scraper/brands').send({
        brandId: 'mondaine_stores',
        brandName: 'MONDAINE',
        endpoint: mondaineProbeOutput,
      });

      const listRes = await request(app).get('/api/scraper/brands');
      const ids = listRes.body.brands.map((b: any) => b.id);
      expect(ids).toContain('bremont_watches');
      expect(ids).toContain('mondaine_stores');
    });

    it('saving a probed endpoint over an existing config requires overwrite flag', async () => {
      const app = createApp();
      // First save succeeds
      await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: bremonProbeOutput,
      });

      // Second save with different URL should conflict
      const conflictRes = await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: { ...bremonProbeOutput, url: 'https://stockist.co/api/v1/different/locations/all' },
        overwrite: false,
      });
      expect(conflictRes.status).toBe(409);

      // With overwrite: true it should succeed
      const overwriteRes = await request(app).post('/api/scraper/brands').send({
        brandId: 'bremont_watches',
        brandName: 'BREMONT',
        endpoint: { ...bremonProbeOutput, url: 'https://stockist.co/api/v1/different/locations/all' },
        overwrite: true,
      });
      expect(overwriteRes.status).toBe(200);
      expect(overwriteRes.body.config.url).toContain('different');
    });
  });
});
