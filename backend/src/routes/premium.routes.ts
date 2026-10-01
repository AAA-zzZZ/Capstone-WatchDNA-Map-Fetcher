import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { premiumImageUploadHandler } from '../middleware/premium-image.middleware';
import { premiumController } from '../controllers/premium.controller';

const router = Router();

// Public — map / admin image preview
router.get('/images/:filename', premiumController.serveStoreImage);

// Public — the map frontend needs this without auth
router.get('/names', premiumController.getNames);

// Admin-only routes
router.get('/shopify-files', authenticate, premiumController.searchShopifyFiles);
router.post('/reconcile', authenticate, premiumController.reconcile);
router.get('/stores', authenticate, premiumController.getStores);
router.post('/stores/merge', authenticate, premiumController.mergeStores);
router.patch('/stores/:handle', authenticate, premiumController.updateStore);
router.post(
  '/stores/:handle/image',
  authenticate,
  premiumImageUploadHandler,
  premiumController.uploadStoreImage
);
router.post('/stores', authenticate, premiumController.markPremium);
router.delete('/stores', authenticate, premiumController.removePremium);
router.delete('/stores/:handle', authenticate, premiumController.deleteStoreFromDatabase);

export default router;
