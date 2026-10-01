import { Request, Response } from 'express';
import locationService from '../services/location.service';

class LocationController {
  /**
   * GET /api/locations
   * List all locations with optional filters
   */
  async listLocations(req: Request, res: Response) {
    try {
      const {
        brand,
        country,
        city,
        status,
        isPremium,
        search,
        limit,
        offset
      } = req.query;

      const filters = {
        brand: brand as string,
        country: country as string,
        city: city as string,
        status: status === 'true' ? true : status === 'false' ? false : undefined,
        isPremium: isPremium === 'true' ? true : isPremium === 'false' ? false : undefined,
        search: search as string,
        limit: limit ? parseInt(limit as string) : 100,
        offset: offset ? parseInt(offset as string) : 0
      };

      const result = await locationService.findAll(filters);
      res.json(result);
    } catch (error: any) {
      console.error('[LocationController] Error listing locations:', error);
      res.status(500).json({ error: 'Failed to fetch locations', message: error.message });
    }
  }

  /**
   * GET /api/locations/nearby
   * Find locations near a coordinate within a radius
   */
  async findNearby(req: Request, res: Response) {
    try {
      const { lat, lng, radius, brand, country, city, status, isPremium } = req.query;

      if (!lat || !lng) {
        return res.status(400).json({ error: 'Missing required parameters: lat, lng' });
      }

      const latitude = parseFloat(lat as string);
      const longitude = parseFloat(lng as string);
      const radiusInMiles = radius ? parseFloat(radius as string) : 25;

      if (isNaN(latitude) || isNaN(longitude) || isNaN(radiusInMiles)) {
        return res.status(400).json({ error: 'Invalid coordinates or radius' });
      }

      const filters = {
        brand: brand as string,
        country: country as string,
        city: city as string,
        status: status === 'true' ? true : status === 'false' ? false : undefined,
        isPremium: isPremium === 'true' ? true : isPremium === 'false' ? false : undefined
      };

      const result = await locationService.findNearby({
        latitude,
        longitude,
        radius: radiusInMiles,
        filters
      });

      res.json(result);
    } catch (error: any) {
      console.error('[LocationController] Error finding nearby locations:', error);
      res.status(500).json({ error: 'Failed to find nearby locations', message: error.message });
    }
  }

  /**
   * GET /api/locations/search
   * Search locations by name or address
   */
  async search(req: Request, res: Response) {
    try {
      const { q, limit } = req.query;

      if (!q) {
        return res.status(400).json({ error: 'Missing required parameter: q (query)' });
      }

      const limitNum = limit ? parseInt(limit as string) : 50;
      const result = await locationService.search(q as string, limitNum);

      res.json(result);
    } catch (error: any) {
      console.error('[LocationController] Error searching locations:', error);
      res.status(500).json({ error: 'Failed to search locations', message: error.message });
    }
  }

  /**
   * GET /api/locations/brands
   * Get list of all unique brands
   */
  async getBrands(req: Request, res: Response) {
    try {
      const brands = await locationService.getBrands();
      res.json({ brands, total: brands.length });
    } catch (error: any) {
      console.error('[LocationController] Error getting brands:', error);
      res.status(500).json({ error: 'Failed to fetch brands', message: error.message });
    }
  }

  /**
   * GET /api/locations/brands/premium
   * Get list of unique premium filter brands.
   */
  async getPremiumBrands(req: Request, res: Response) {
    try {
      const brands = await locationService.getPremiumFilterBrands();
      res.json({ brands, total: brands.length });
    } catch (error: any) {
      console.error('[LocationController] Error getting premium brands:', error);
      res.status(500).json({ error: 'Failed to fetch premium brands', message: error.message });
    }
  }

  /**
   * GET /api/locations/stats
   * Get statistics about locations
   */
  async getStats(req: Request, res: Response) {
    try {
      const stats = await locationService.getStats();
      res.json(stats);
    } catch (error: any) {
      console.error('[LocationController] Error getting stats:', error);
      res.status(500).json({ error: 'Failed to fetch statistics', message: error.message });
    }
  }

  /**
   * GET /api/locations/:id
   * Get a single location by ID
   */
  async getLocation(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const location = await locationService.findById(id);

      if (!location) {
        return res.status(404).json({ error: 'Location not found' });
      }

      res.json(location);
    } catch (error: any) {
      console.error('[LocationController] Error getting location:', error);
      res.status(500).json({ error: 'Failed to fetch location', message: error.message });
    }
  }
}

export default new LocationController();
