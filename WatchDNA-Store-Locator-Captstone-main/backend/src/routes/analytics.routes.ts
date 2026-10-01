import { Router } from 'express';
import analyticsController from '../controllers/analytics.controller';
import { authenticate, requireRole } from '../middleware/auth.middleware';

const router = Router();

// Public endpoints (called by mobile app)
router.post('/events', analyticsController.recordEvent);
router.post('/events/batch', analyticsController.recordBatch);

// Admin-only endpoints (called by admin panel)
router.get('/summary', authenticate, requireRole(['admin', 'viewer']), analyticsController.getSummary);
router.get('/retailers', authenticate, requireRole(['admin', 'viewer']), analyticsController.getRetailers);
router.get('/brands', authenticate, requireRole(['admin', 'viewer']), analyticsController.getBrands);
router.get('/actions', authenticate, requireRole(['admin', 'viewer']), analyticsController.getActions);
router.get('/sources', authenticate, requireRole(['admin', 'viewer']), analyticsController.getSources);
router.get('/daily', authenticate, requireRole(['admin', 'viewer']), analyticsController.getDaily);

export default router;
