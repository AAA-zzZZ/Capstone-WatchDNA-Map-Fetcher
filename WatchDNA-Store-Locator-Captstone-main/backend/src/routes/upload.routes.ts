import { Router } from 'express';
import uploadController from '../controllers/upload.controller';
import { uploadMiddleware } from '../middleware/upload.middleware';
import { authenticate, requireRole } from '../middleware/auth.middleware';
import { geocodeLimiter, uploadLimiter } from '../middleware/rateLimiter';

const router = Router();

// All routes require authentication
router.use(authenticate);

// POST /api/uploads - Upload CSV file (admin only)
router.post('/', uploadLimiter, requireRole(['admin']), uploadMiddleware.single('file'), uploadController.uploadCSV);

// GET /api/uploads - List all uploads
router.get('/', uploadController.listUploads);

// GET /api/uploads/stats - Get statistics
router.get('/stats', uploadController.getStats);

// GET /api/uploads/master/download - Download master CSV file (must be before /:id routes)
router.get('/master/download', uploadController.downloadMasterCSV);

// POST /api/uploads/manual-store — add one location via same validation + import as CSV (admin only)
router.post('/manual-store', uploadLimiter, requireRole(['admin']), uploadController.createManualStore);

// POST /api/uploads/geocode-address — lookup lat/lon for manual add form (admin only; must be before /:id)
router.post('/geocode-address', geocodeLimiter, requireRole(['admin']), uploadController.geocodeAddress);

// GET /api/uploads/:id - Get single upload details
router.get('/:id', uploadController.getUpload);

// GET /api/uploads/:id/logs - Get validation logs for upload
router.get('/:id/logs', uploadController.getValidationLogs);

// GET /api/uploads/:id/download - Download upload CSV file
router.get('/:id/download', uploadController.downloadUpload);

// POST /api/uploads/:id/revalidate - Re-validate upload with options (admin only)
router.post('/:id/revalidate', requireRole(['admin']), uploadController.revalidateUpload);

// DELETE /api/uploads/:id - Delete upload (admin only)
router.delete('/:id', requireRole(['admin']), uploadController.deleteUpload);

export default router;
