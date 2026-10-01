import { Request, Response } from 'express';
import analyticsService from '../services/analytics.service';
import { AuthRequest } from '../middleware/auth.middleware';

class AnalyticsController {
  /**
   * POST /api/analytics/events
   * Record a single analytics event (public, from mobile app)
   */
  async recordEvent(req: Request, res: Response) {
    try {
      const { event, properties, sessionId, deviceType } = req.body;

      if (!event || typeof event !== 'string') {
        return res.status(400).json({ error: 'Missing required field: event' });
      }

      await analyticsService.recordEvent({
        event,
        properties,
        sessionId,
        deviceType,
      });

      res.status(201).json({ success: true });
    } catch (error: any) {
      console.error('[AnalyticsController] Error recording event:', error);
      res.status(500).json({ error: 'Failed to record event' });
    }
  }

  /**
   * POST /api/analytics/events/batch
   * Record multiple analytics events at once (public, from mobile app)
   */
  async recordBatch(req: Request, res: Response) {
    try {
      const { events } = req.body;

      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'Missing or empty events array' });
      }

      if (events.length > 100) {
        return res.status(400).json({ error: 'Maximum 100 events per batch' });
      }

      const valid = events.every(
        (e: any) => e.event && typeof e.event === 'string'
      );
      if (!valid) {
        return res
          .status(400)
          .json({ error: 'Each event must have an "event" string field' });
      }

      const result = await analyticsService.recordBatch(events);
      res.status(201).json({ success: true, count: result.count });
    } catch (error: any) {
      console.error('[AnalyticsController] Error recording batch:', error);
      res.status(500).json({ error: 'Failed to record events' });
    }
  }

  /**
   * GET /api/analytics/summary
   * Overview stats (admin only)
   */
  async getSummary(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const summary = await analyticsService.getSummary(days);
      res.json(summary);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting summary:', error);
      res.status(500).json({ error: 'Failed to fetch summary' });
    }
  }

  /**
   * GET /api/analytics/retailers
   * Top retailers by engagement (admin only)
   */
  async getRetailers(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const retailers = await analyticsService.getRetailerStats(days);
      res.json(retailers);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting retailers:', error);
      res.status(500).json({ error: 'Failed to fetch retailer stats' });
    }
  }

  /**
   * GET /api/analytics/brands
   * Top searched/viewed brands (admin only)
   */
  async getBrands(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const brands = await analyticsService.getBrandStats(days);
      res.json(brands);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting brands:', error);
      res.status(500).json({ error: 'Failed to fetch brand stats' });
    }
  }

  /**
   * GET /api/analytics/actions
   * Phone/directions/website click counts (admin only)
   */
  async getActions(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const actions = await analyticsService.getActionStats(days);
      res.json(actions);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting actions:', error);
      res.status(500).json({ error: 'Failed to fetch action stats' });
    }
  }

  /**
   * GET /api/analytics/sources
   * Store locator vs search directory traffic (admin only)
   */
  async getSources(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const sources = await analyticsService.getSourceStats(days);
      res.json(sources);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting sources:', error);
      res.status(500).json({ error: 'Failed to fetch source stats' });
    }
  }

  /**
   * GET /api/analytics/daily
   * Daily event counts for time series (admin only)
   */
  async getDaily(req: AuthRequest, res: Response) {
    try {
      const days = parseInt(req.query.days as string) || 30;
      const daily = await analyticsService.getDailyStats(days);
      res.json(daily);
    } catch (error: any) {
      console.error('[AnalyticsController] Error getting daily stats:', error);
      res.status(500).json({ error: 'Failed to fetch daily stats' });
    }
  }
}

export default new AnalyticsController();
