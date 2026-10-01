import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock auth service before importing routes
vi.mock('../../services/auth.service', () => {
  const mockService = {
    login: vi.fn(),
    verifyToken: vi.fn(),
    getUserById: vi.fn(),
    listUsers: vi.fn(),
    hashPassword: vi.fn(),
    comparePassword: vi.fn(),
    generateToken: vi.fn(),
  };
  return {
    __esModule: true,
    default: mockService,
    AuthService: vi.fn(() => mockService),
  };
});

import authService from '../../services/auth.service';
import authRoutes from '../../routes/auth.routes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  return app;
}

describe('Auth Routes Integration', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  describe('POST /api/auth/login', () => {
    it('should return 400 when username is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ password: 'test123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('should return 400 when password is missing', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('should return 400 when body is empty', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({});

      expect(res.status).toBe(400);
    });

    it('should return 401 for invalid credentials', async () => {
      (authService.login as any).mockRejectedValue(
        new Error('Invalid username or password')
      );

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid username or password');
    });

    it('should return token and user on successful login', async () => {
      const mockResult = {
        user: { id: '1', username: 'admin', email: 'admin@test.com', role: 'admin' },
        token: 'mock-jwt-token',
      };
      (authService.login as any).mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.token).toBe('mock-jwt-token');
      expect(res.body.user.username).toBe('admin');
    });

    it('should not expose password hash in login response', async () => {
      const mockResult = {
        user: { id: '1', username: 'admin', email: 'admin@test.com', role: 'admin' },
        token: 'mock-jwt-token',
      };
      (authService.login as any).mockResolvedValue(mockResult);

      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'admin', password: 'admin123' });

      expect(res.body.user.passwordHash).toBeUndefined();
      expect(res.body.user.password).toBeUndefined();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return success message', async () => {
      const res = await request(app)
        .post('/api/auth/logout');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Logged out');
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .get('/api/auth/me');

      expect(res.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      (authService.verifyToken as any).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
    });

    it('should return user info with valid token', async () => {
      const mockUser = { id: '1', username: 'admin', email: 'admin@test.com', role: 'admin' };
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      (authService.getUserById as any).mockResolvedValue(mockUser);

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('admin');
    });
  });

  describe('GET /api/auth/users', () => {
    it('should return 401 without auth token', async () => {
      const res = await request(app)
        .get('/api/auth/users');

      expect(res.status).toBe(401);
    });

    it('should return 403 for non-admin users', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '2', username: 'viewer', email: 'viewer@test.com', role: 'viewer',
      });

      const res = await request(app)
        .get('/api/auth/users')
        .set('Authorization', 'Bearer viewer-token');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Insufficient permissions');
    });

    it('should return user list for admin', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      (authService.listUsers as any).mockResolvedValue([
        { id: '1', username: 'admin', email: 'admin@test.com', role: 'admin' },
      ]);

      const res = await request(app)
        .get('/api/auth/users')
        .set('Authorization', 'Bearer admin-token');

      expect(res.status).toBe(200);
      expect(res.body.users).toHaveLength(1);
    });
  });
});
