import { Router } from 'express';
import authController from '../controllers/auth.controller';
import { authenticate, requireRole } from '../middleware/auth.middleware';

const router = Router();

// POST /api/auth/login - Login
router.post('/login', authController.login);

// POST /api/auth/logout - Logout
router.post('/logout', authController.logout);

// GET /api/auth/me - Get current user
router.get('/me', authenticate, authController.me);

// GET /api/auth/users - List all users (admin only)
router.get('/users', authenticate, requireRole(['admin']), authController.listUsers);

// GET /api/auth/shopify-verify - Verify Shopify embedded-app HMAC signature
router.get('/shopify-verify', authController.verifyShopifyHmac.bind(authController));

export default router;
