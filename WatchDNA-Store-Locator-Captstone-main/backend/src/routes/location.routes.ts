import { Router } from 'express';
import locationController from '../controllers/location.controller';

const router = Router();

// Public endpoints (no authentication required)
router.get('/nearby', locationController.findNearby);
router.get('/search', locationController.search);
router.get('/brands/premium', locationController.getPremiumBrands);
router.get('/brands', locationController.getBrands);
router.get('/stats', locationController.getStats);
router.get('/:id', locationController.getLocation);
router.get('/', locationController.listLocations);

export default router;
