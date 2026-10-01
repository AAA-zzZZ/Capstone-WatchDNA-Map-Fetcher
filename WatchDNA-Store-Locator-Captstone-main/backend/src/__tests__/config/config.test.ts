import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

describe('Configuration Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('config values', () => {
    it('should use default port 3001 when PORT is not set', async () => {
      delete process.env.PORT;
      const { config } = await import('../../config');
      expect(config.port).toBe(3001);
    });

    it('should parse PORT from environment variable', async () => {
      process.env.PORT = '5000';
      const { config } = await import('../../config');
      expect(config.port).toBe(5000);
    });

    it('should default to development mode', async () => {
      delete process.env.NODE_ENV;
      const { config } = await import('../../config');
      expect(config.nodeEnv).toBe('development');
    });

    it('should parse ALLOWED_ORIGINS as comma-separated list', async () => {
      process.env.ALLOWED_ORIGINS = 'http://localhost:3000,https://app.example.com';
      const { config } = await import('../../config');
      expect(config.cors.allowedOrigins).toEqual([
        'http://localhost:3000',
        'https://app.example.com',
      ]);
    });

    it('should default ALLOWED_ORIGINS to localhost:5173', async () => {
      delete process.env.ALLOWED_ORIGINS;
      const { config } = await import('../../config');
      expect(config.cors.allowedOrigins).toEqual(['http://localhost:5173']);
    });

    it('should set upload max size to 10MB', async () => {
      const { config } = await import('../../config');
      expect(config.upload.maxSize).toBe(10 * 1024 * 1024);
    });

    it('should parse rate limit configuration from env', async () => {
      process.env.RATE_LIMIT_WINDOW_MS = '60000';
      process.env.RATE_LIMIT_MAX_REQUESTS = '50';
      const { config } = await import('../../config');
      expect(config.rateLimit.windowMs).toBe(60000);
      expect(config.rateLimit.maxRequests).toBe(50);
    });
  });

  describe('validateConfig - production', () => {
    it('should throw when DATABASE_URL is missing in production', async () => {
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      process.env.JWT_SECRET = 'a-very-long-secret-that-is-at-least-32-characters';
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('Missing required environment variables');
    });

    it('should throw when JWT_SECRET is missing in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      delete process.env.JWT_SECRET;
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('Missing required environment variables');
    });

    it('should throw when ALLOWED_ORIGINS is missing in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.JWT_SECRET = 'a-very-long-secret-that-is-at-least-32-characters';
      delete process.env.ALLOWED_ORIGINS;

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('Missing required environment variables');
    });

    it('should throw when JWT_SECRET is too short in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.JWT_SECRET = 'short';
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('JWT_SECRET must be at least 32 characters');
    });

    it('should throw when using default JWT_SECRET in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.JWT_SECRET = 'change_this_to_random_secret_in_production';
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('default JWT_SECRET in production');
    });

    it('should pass validation with proper production config', async () => {
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://localhost/test';
      process.env.JWT_SECRET = 'a-very-long-secret-that-is-at-least-32-characters!!';
      process.env.ALLOWED_ORIGINS = 'https://app.example.com';

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { validateConfig } = await import('../../config');

      expect(() => validateConfig()).not.toThrow();
      consoleSpy.mockRestore();
    });
  });

  describe('validateConfig - development', () => {
    it('should throw when DATABASE_URL is not set at all', async () => {
      process.env.NODE_ENV = 'development';
      delete process.env.DATABASE_URL;

      const { validateConfig } = await import('../../config');
      expect(() => validateConfig()).toThrow('DATABASE_URL is required');
    });

    it('should pass validation in development with DATABASE_URL set', async () => {
      process.env.NODE_ENV = 'development';
      process.env.DATABASE_URL = 'file:./dev.db';

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { validateConfig } = await import('../../config');

      expect(() => validateConfig()).not.toThrow();
      consoleSpy.mockRestore();
    });
  });
});
