import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { premiumController } from '../controllers/premium.controller';

const router = Router();

router.post('/reconcile-premium', authenticate, premiumController.reconcilePremiumProgram);

export default router;
