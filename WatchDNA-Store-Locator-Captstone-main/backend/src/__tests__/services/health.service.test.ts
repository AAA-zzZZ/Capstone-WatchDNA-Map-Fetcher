import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { execSync } from 'child_process';

// Mock dependencies before importing the service
vi.mock('../../lib/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: vi.fn(),
    user: { count: vi.fn() },
    premiumStore: { count: vi.fn() },
    brandConfig: { count: vi.fn() },
  },
}));

vi.mock('../../utils/paths', () => ({
  PYTHON_CMD: 'python3',
  VALIDATE_CSV_PATH: '/fake/path/validate_csv.py',
  SCRAPER_PATH: '/fake/path/scrapers',
}));

vi.mock('../../config', () => ({
  config: {
    nodeEnv: 'development',
    isDevelopment: true,
    isProduction: false,
    upload: { dir: './uploads' },
    cors: { allowedOrigins: ['http://localhost:5173'] },
  },
}));

vi.mock('child_process', () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from('Python 3.11.0')),
}));

import prisma from '../../lib/prisma';
import { getHealthReport } from '../../services/health.service';

describe('Health Service', () => {
  let existsSyncSpy: any;
  let writeFileSyncSpy: any;
  let unlinkSyncSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    unlinkSyncSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {});
    (prisma.$queryRaw as any).mockResolvedValue([{ count: BigInt(500) }]);
    (prisma.user.count as any).mockResolvedValue(1);
    (prisma.premiumStore.count as any).mockResolvedValue(5);
    (prisma.brandConfig.count as any).mockResolvedValue(3);
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
    unlinkSyncSpy.mockRestore();
  });

  describe('getHealthReport', () => {
    it('should return a complete health report', async () => {
      const report = await getHealthReport();

      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('uptime');
      expect(report).toHaveProperty('environment');
      expect(report).toHaveProperty('services');
      expect(report).toHaveProperty('summary');
    });

    it('should check all 6 services', async () => {
      const report = await getHealthReport();

      expect(report.services).toHaveLength(6);
      const serviceNames = report.services.map(s => s.name);
      expect(serviceNames).toContain('PostgreSQL Database');
      expect(serviceNames).toContain('Authentication Service');
      expect(serviceNames).toContain('Premium Store Registry');
      expect(serviceNames).toContain('File System');
      expect(serviceNames).toContain('Python Environment');
      expect(serviceNames).toContain('Security Configuration');
    });

    it('should report healthy when all services pass', async () => {
      const report = await getHealthReport();

      expect(report.status).toBe('healthy');
      expect(report.summary.healthy).toBe(6);
      expect(report.summary.unhealthy).toBe(0);
    });

    it('should include location and brand config counts from database check', async () => {
      const report = await getHealthReport();

      const dbService = report.services.find(s => s.name === 'PostgreSQL Database');
      expect(dbService?.status).toBe('healthy');
      expect(dbService?.details?.locationCount).toBe(500);
      expect(dbService?.details?.brandConfigCount).toBe(3);
    });

    it('should include response times for all services', async () => {
      const report = await getHealthReport();

      report.services.forEach(service => {
        expect(service.responseTime).toBeGreaterThanOrEqual(0);
        expect(typeof service.responseTime).toBe('number');
      });
    });

    it('should report uptime in seconds', async () => {
      const report = await getHealthReport();
      expect(report.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include accurate summary counts', async () => {
      const report = await getHealthReport();
      const { healthy, degraded, unhealthy, total } = report.summary;

      expect(total).toBe(6);
      expect(healthy + degraded + unhealthy).toBe(total);
    });
  });

  describe('Database check failure', () => {
    it('should report unhealthy when database is down', async () => {
      (prisma.$queryRaw as any).mockRejectedValue(new Error('Connection refused'));

      const report = await getHealthReport();

      const dbService = report.services.find(s => s.name === 'PostgreSQL Database');
      expect(dbService?.status).toBe('unhealthy');
      expect(dbService?.message).toContain('Connection failed');
      expect(report.status).toBe('unhealthy');
    });
  });

  describe('Auth check', () => {
    it('should report degraded when no admin users exist', async () => {
      (prisma.user.count as any).mockResolvedValue(0);

      const report = await getHealthReport();

      const authService = report.services.find(s => s.name === 'Authentication Service');
      expect(authService?.status).toBe('degraded');
      expect(authService?.message).toContain('No admin users');
    });
  });

  describe('Premium store check', () => {
    it('should report degraded when no premium stores configured', async () => {
      (prisma.premiumStore.count as any).mockResolvedValue(0);

      const report = await getHealthReport();

      const premiumService = report.services.find(s => s.name === 'Premium Store Registry');
      expect(premiumService?.status).toBe('degraded');
      expect(premiumService?.message).toContain('No premium stores');
    });
  });

  describe('Overall status calculation', () => {
    it('should be degraded when any service is degraded', async () => {
      (prisma.premiumStore.count as any).mockResolvedValue(0);

      const report = await getHealthReport();
      expect(report.status).toBe('degraded');
    });

    it('should be unhealthy when any service is unhealthy', async () => {
      (prisma.$queryRaw as any).mockRejectedValue(new Error('DB down'));

      const report = await getHealthReport();
      expect(report.status).toBe('unhealthy');
    });
  });
});
