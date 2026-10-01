import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock location service
vi.mock('../../services/location.service', () => ({
  __esModule: true,
  default: {
    findAll: vi.fn(),
    findNearby: vi.fn(),
    search: vi.fn(),
    getBrands: vi.fn(),
    getPremiumFilterBrands: vi.fn(),
    getStats: vi.fn(),
    findById: vi.fn(),
  },
}));

import locationService from '../../services/location.service';
import locationRoutes from '../../routes/location.routes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/locations', locationRoutes);
  return app;
}

describe('Location Routes Integration', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  describe('GET /api/locations', () => {
    it('should return locations list', async () => {
      const mockResult = {
        locations: [{ id: '1', name: 'Test Store', latitude: 40.7, longitude: -74.0 }],
        total: 1,
      };
      (locationService.findAll as any).mockResolvedValue(mockResult);

      const res = await request(app).get('/api/locations');

      expect(res.status).toBe(200);
      expect(res.body.locations).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('should pass query filters to service', async () => {
      (locationService.findAll as any).mockResolvedValue({ locations: [], total: 0 });

      await request(app)
        .get('/api/locations')
        .query({ brand: 'OMEGA', country: 'US', limit: '10', offset: '5' });

      expect(locationService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          brand: 'OMEGA',
          country: 'US',
          limit: 10,
          offset: 5,
        })
      );
    });

    it('should default limit to 100 and offset to 0', async () => {
      (locationService.findAll as any).mockResolvedValue({ locations: [], total: 0 });

      await request(app).get('/api/locations');

      expect(locationService.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 100,
          offset: 0,
        })
      );
    });

    it('should not require authentication (public endpoint)', async () => {
      (locationService.findAll as any).mockResolvedValue({ locations: [], total: 0 });

      const res = await request(app).get('/api/locations');

      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/locations/nearby', () => {
    it('should return 400 when lat is missing', async () => {
      const res = await request(app)
        .get('/api/locations/nearby')
        .query({ lng: '-74.006' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required parameters');
    });

    it('should return 400 when lng is missing', async () => {
      const res = await request(app)
        .get('/api/locations/nearby')
        .query({ lat: '40.7128' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required parameters');
    });

    it('should return 400 for non-numeric coordinates', async () => {
      const res = await request(app)
        .get('/api/locations/nearby')
        .query({ lat: 'abc', lng: 'def' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid coordinates');
    });

    it('should return 400 for non-numeric radius', async () => {
      const res = await request(app)
        .get('/api/locations/nearby')
        .query({ lat: '40.7128', lng: '-74.006', radius: 'big' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid coordinates or radius');
    });

    it('should return nearby locations with valid coordinates', async () => {
      const mockResult = {
        locations: [
          { id: '1', name: 'Nearby Store', distance: 2.5, latitude: 40.71, longitude: -74.01 },
        ],
        total: 1,
      };
      (locationService.findNearby as any).mockResolvedValue(mockResult);

      const res = await request(app)
        .get('/api/locations/nearby')
        .query({ lat: '40.7128', lng: '-74.006', radius: '10' });

      expect(res.status).toBe(200);
      expect(locationService.findNearby).toHaveBeenCalledWith({
        latitude: 40.7128,
        longitude: -74.006,
        radius: 10,
        filters: expect.any(Object),
      });
    });

    it('should default radius to 25 miles', async () => {
      (locationService.findNearby as any).mockResolvedValue({ locations: [], total: 0 });

      await request(app)
        .get('/api/locations/nearby')
        .query({ lat: '40.7128', lng: '-74.006' });

      expect(locationService.findNearby).toHaveBeenCalledWith(
        expect.objectContaining({ radius: 25 })
      );
    });
  });

  describe('GET /api/locations/search', () => {
    it('should return 400 when query parameter q is missing', async () => {
      const res = await request(app).get('/api/locations/search');

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Missing required parameter');
    });

    it('should search locations with query string', async () => {
      const mockResult = {
        locations: [{ id: '1', name: 'Rolex Boutique' }],
        total: 1,
      };
      (locationService.search as any).mockResolvedValue(mockResult);

      const res = await request(app)
        .get('/api/locations/search')
        .query({ q: 'Rolex' });

      expect(res.status).toBe(200);
      expect(locationService.search).toHaveBeenCalledWith('Rolex', 50);
    });

    it('should respect custom limit parameter', async () => {
      (locationService.search as any).mockResolvedValue({ locations: [], total: 0 });

      await request(app)
        .get('/api/locations/search')
        .query({ q: 'test', limit: '10' });

      expect(locationService.search).toHaveBeenCalledWith('test', 10);
    });
  });

  describe('GET /api/locations/brands', () => {
    it('should return list of brands with total count', async () => {
      const mockBrands = ['OMEGA', 'ROLEX', 'TAG HEUER'];
      (locationService.getBrands as any).mockResolvedValue(mockBrands);

      const res = await request(app).get('/api/locations/brands');

      expect(res.status).toBe(200);
      expect(res.body.brands).toEqual(mockBrands);
      expect(res.body.total).toBe(3);
    });
  });

  describe('GET /api/locations/brands/premium', () => {
    it('should return list of premium filter brands with total count', async () => {
      const mockBrands = ['OMEGA', 'ROLEX'];
      (locationService.getPremiumFilterBrands as any).mockResolvedValue(mockBrands);

      const res = await request(app).get('/api/locations/brands/premium');

      expect(res.status).toBe(200);
      expect(res.body.brands).toEqual(mockBrands);
      expect(res.body.total).toBe(2);
    });
  });

  describe('GET /api/locations/stats', () => {
    it('should return location statistics', async () => {
      const mockStats = { totalLocations: 500, totalBrands: 25, totalCountries: 40 };
      (locationService.getStats as any).mockResolvedValue(mockStats);

      const res = await request(app).get('/api/locations/stats');

      expect(res.status).toBe(200);
      expect(res.body.totalLocations).toBe(500);
    });
  });

  describe('GET /api/locations/:id', () => {
    it('should return a single location by ID', async () => {
      const mockLocation = { id: 'abc-123', name: 'Test Watch Store', latitude: 40.7, longitude: -74.0 };
      (locationService.findById as any).mockResolvedValue(mockLocation);

      const res = await request(app).get('/api/locations/abc-123');

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Test Watch Store');
    });

    it('should return 404 when location is not found', async () => {
      (locationService.findById as any).mockResolvedValue(null);

      const res = await request(app).get('/api/locations/nonexistent-id');

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });
});
