import { Request, Response } from 'express';
import crypto from 'crypto';
import authService from '../services/auth.service';
import { config } from '../config';

export class AuthController {

  async login(req: Request, res: Response) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const result = await authService.login({ username, password });

      res.json({
        success: true,
        ...result
      });

    } catch (error: any) {
      console.error('Login error:', error);

      if (error.message === 'Invalid username or password') {
        return res.status(401).json({ error: error.message });
      }

      res.status(500).json({ error: 'Login failed' });
    }
  }

  async logout(req: Request, res: Response) {
    // For JWT, logout is handled client-side by removing the token
    res.json({
      success: true,
      message: 'Logged out successfully'
    });
  }

  async me(req: Request, res: Response) {
    try {
      // User is attached by auth middleware
      const userId = (req as any).user?.userId;

      if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const user = await authService.getUserById(userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ user });

    } catch (error: any) {
      console.error('Get user error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  async listUsers(req: Request, res: Response) {
    try {
      const users = await authService.listUsers();
      res.json({ users });
    } catch (error: any) {
      console.error('List users error:', error);
      res.status(500).json({ error: error.message });
    }
  }

  /**
   * Verifies the HMAC signature Shopify appends when loading an embedded app.
   * All query params except `hmac` are sorted, joined, and HMAC-SHA256 signed
   * with SHOPIFY_CLIENT_SECRET. Returns { valid: true } on success.
   */
  verifyShopifyHmac(req: Request, res: Response) {
    const secret = config.shopify.clientSecret;
    if (!secret) {
      return res.status(503).json({ error: 'Shopify integration not configured' });
    }

    const { hmac, ...rest } = req.query as Record<string, string>;
    if (!hmac) {
      return res.status(400).json({ error: 'Missing hmac parameter' });
    }

    const message = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${rest[k]}`)
      .join('&');

    const digestBuf = Buffer.from(
      crypto.createHmac('sha256', secret).update(message).digest('hex')
    );
    const hmacBuf = Buffer.from(hmac);

    const valid =
      digestBuf.length === hmacBuf.length &&
      crypto.timingSafeEqual(digestBuf, hmacBuf);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid Shopify HMAC' });
    }

    res.json({ valid: true });
  }
}

export default new AuthController();
