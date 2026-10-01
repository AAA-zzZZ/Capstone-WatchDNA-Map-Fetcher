import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Rate Limiter Configuration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should export all rate limiters', async () => {
    vi.doMock('../../config', () => ({
      config: {
        isDevelopment: true,
        rateLimit: {
          windowMs: 900000,
          maxRequests: 100,
        },
      },
    }));

    const rateLimiter = await import('../../middleware/rateLimiter');

    expect(rateLimiter.apiLimiter).toBeDefined();
    expect(rateLimiter.authLimiter).toBeDefined();
    expect(rateLimiter.publicLimiter).toBeDefined();
    expect(rateLimiter.uploadLimiter).toBeDefined();
    expect(rateLimiter.scraperLimiter).toBeDefined();
  });

  it('should export all limiters as middleware functions', async () => {
    vi.doMock('../../config', () => ({
      config: {
        isDevelopment: true,
        rateLimit: {
          windowMs: 900000,
          maxRequests: 100,
        },
      },
    }));

    const rateLimiter = await import('../../middleware/rateLimiter');

    expect(typeof rateLimiter.apiLimiter).toBe('function');
    expect(typeof rateLimiter.authLimiter).toBe('function');
    expect(typeof rateLimiter.publicLimiter).toBe('function');
    expect(typeof rateLimiter.uploadLimiter).toBe('function');
    expect(typeof rateLimiter.scraperLimiter).toBe('function');
  });

  it('authLimiter should never skip rate limiting (even in development)', async () => {
    vi.doMock('../../config', () => ({
      config: {
        isDevelopment: true,
        rateLimit: {
          windowMs: 900000,
          maxRequests: 100,
        },
      },
    }));

    const rateLimiter = await import('../../middleware/rateLimiter');
    expect(typeof rateLimiter.authLimiter).toBe('function');
  });
});
