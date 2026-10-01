import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { securityHeaders } from '../../middleware/security';

// Mock the config module
vi.mock('../../config', () => ({
  config: {
    isProduction: false,
    isDevelopment: true,
  },
}));

describe('Security Headers Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let headers: Record<string, string>;

  beforeEach(() => {
    headers = {};
    mockReq = {};
    mockRes = {
      setHeader: vi.fn((key: string, value: string) => {
        headers[key] = value;
        return mockRes as Response;
      }),
    };
    mockNext = vi.fn();
  });

  it('should call next()', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
  });

  it('should set X-Frame-Options to DENY', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
  });

  it('should set X-Content-Type-Options to nosniff', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
  });

  it('should set X-XSS-Protection header', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
  });

  it('should set Referrer-Policy header', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  it('should set Permissions-Policy allowing only geolocation for self', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Permissions-Policy',
      'geolocation=(self), microphone=(), camera=(), payment=()'
    );
  });

  it('should NOT set CSP in development mode', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).not.toHaveBeenCalledWith(
      'Content-Security-Policy',
      expect.any(String)
    );
  });

  it('should NOT set Strict-Transport-Security in development mode', () => {
    securityHeaders(mockReq as Request, mockRes as Response, mockNext);
    expect(mockRes.setHeader).not.toHaveBeenCalledWith(
      'Strict-Transport-Security',
      expect.any(String)
    );
  });

  describe('Production mode', () => {
    beforeEach(() => {
      // Override mock to simulate production
      vi.resetModules();
    });

    it('should set CSP and HSTS in production mode', async () => {
      vi.doMock('../../config', () => ({
        config: {
          isProduction: true,
          isDevelopment: false,
        },
      }));

      const { securityHeaders: prodSecurityHeaders } = await import('../../middleware/security');
      prodSecurityHeaders(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining("default-src 'self'")
      );
      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        expect.stringContaining('max-age=31536000')
      );
    });

    it('should include frame-ancestors none in CSP', async () => {
      vi.doMock('../../config', () => ({
        config: {
          isProduction: true,
          isDevelopment: false,
        },
      }));

      const { securityHeaders: prodSecurityHeaders } = await import('../../middleware/security');
      prodSecurityHeaders(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining("frame-ancestors 'none'")
      );
    });

    it('should include HSTS preload directive in production', async () => {
      vi.doMock('../../config', () => ({
        config: {
          isProduction: true,
          isDevelopment: false,
        },
      }));

      const { securityHeaders: prodSecurityHeaders } = await import('../../middleware/security');
      prodSecurityHeaders(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        expect.stringContaining('preload')
      );
    });
  });
});
