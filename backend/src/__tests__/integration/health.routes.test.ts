import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock health service
vi.mock('../../services/health.service', () => ({
  getHealthReport: vi.fn(),
}));

// Mock auth service for authenticated routes
vi.mock('../../services/auth.service', () => ({
  __esModule: true,
  default: {
    verifyToken: vi.fn(),
  },
}));

import { getHealthReport } from '../../services/health.service';
import authService from '../../services/auth.service';
import healthRoutes from '../../routes/health.routes';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/health', healthRoutes);
  return app;
}

const mockHealthReport = {
  status: 'healthy',
  timestamp: '2026-03-16T12:00:00.000Z',
  uptime: 3600,
  environment: 'development',
  version: '1.0.0',
  services: [
    { name: 'PostgreSQL Database', status: 'healthy', responseTime: 5, message: 'Connected' },
    { name: 'Authentication Service', status: 'healthy', responseTime: 2, message: '1 admin user' },
    { name: 'File System', status: 'healthy', responseTime: 1, message: 'Writable' },
    { name: 'Python Environment', status: 'healthy', responseTime: 50, message: 'Python 3.11' },
    { name: 'Security Configuration', status: 'healthy', responseTime: 0, message: 'OK' },
    { name: 'Premium Store Registry', status: 'healthy', responseTime: 3, message: '5 stores' },
  ],
  summary: { total: 6, healthy: 6, degraded: 0, unhealthy: 0 },
};

describe('Health Routes', () => {
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return simple health ping without authentication', async () => {
      const res = await request(app).get('/health');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('WatchDNA Admin Backend');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('GET /health/details', () => {
    it('should return 401 without authentication', async () => {
      const res = await request(app).get('/health/details');
      expect(res.status).toBe(401);
    });

    it('should return full health report for authenticated admin', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      (getHealthReport as any).mockResolvedValue(mockHealthReport);

      const res = await request(app)
        .get('/health/details')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('healthy');
      expect(res.body.services).toHaveLength(6);
      expect(res.body.summary.total).toBe(6);
    });

    it('should return 200 for degraded status', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      const degradedReport = { ...mockHealthReport, status: 'degraded' };
      (getHealthReport as any).mockResolvedValue(degradedReport);

      const res = await request(app)
        .get('/health/details')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
    });

    it('should return 503 for unhealthy status', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      const unhealthyReport = { ...mockHealthReport, status: 'unhealthy' };
      (getHealthReport as any).mockResolvedValue(unhealthyReport);

      const res = await request(app)
        .get('/health/details')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(503);
    });
  });

  describe('GET /health/dashboard', () => {
    it('should return 401 without authentication', async () => {
      const res = await request(app).get('/health/dashboard');
      expect(res.status).toBe(401);
    });

    it('should return HTML dashboard for authenticated admin', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      (getHealthReport as any).mockResolvedValue(mockHealthReport);

      const res = await request(app)
        .get('/health/dashboard')
        .set('Authorization', 'Bearer valid-token');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('WATCHDNA SYSTEM STATUS');
      expect(res.text).toContain('PostgreSQL Database');
      expect(res.text).toContain('All Systems Operational');
    });

    it('should show degraded status on dashboard', async () => {
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin',
      });
      const degradedReport = { ...mockHealthReport, status: 'degraded' };
      (getHealthReport as any).mockResolvedValue(degradedReport);

      const res = await request(app)
        .get('/health/dashboard')
        .set('Authorization', 'Bearer valid-token');

      expect(res.text).toContain('Degraded');
    });
  });
});
