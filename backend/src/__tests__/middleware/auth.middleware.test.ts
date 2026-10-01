import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Response, NextFunction } from 'express';
import { authenticate, requireRole, optionalAuth, AuthRequest } from '../../middleware/auth.middleware';

// Mock the auth service
vi.mock('../../services/auth.service', () => ({
  __esModule: true,
  default: {
    verifyToken: vi.fn(),
  },
}));

import authService from '../../services/auth.service';

describe('Auth Middleware', () => {
  let mockReq: Partial<AuthRequest>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      headers: {},
    };
    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
  });

  describe('authenticate', () => {
    it('should return 401 when no Authorization header is provided', async () => {
      await authenticate(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'No token provided' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      mockReq.headers = { authorization: 'Basic abc123' };

      await authenticate(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'No token provided' });
    });

    it('should return 401 when token is invalid', async () => {
      mockReq.headers = { authorization: 'Bearer invalid-token' };
      (authService.verifyToken as any).mockImplementation(() => {
        throw new Error('Invalid or expired token');
      });

      await authenticate(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    });

    it('should attach user to request and call next() with valid token', async () => {
      const mockPayload = {
        userId: '123',
        username: 'testuser',
        email: 'test@test.com',
        role: 'admin',
      };
      mockReq.headers = { authorization: 'Bearer valid-token' };
      (authService.verifyToken as any).mockReturnValue(mockPayload);

      await authenticate(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockReq.user).toEqual(mockPayload);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should extract token correctly from Bearer prefix', async () => {
      mockReq.headers = { authorization: 'Bearer my-jwt-token-here' };
      (authService.verifyToken as any).mockReturnValue({
        userId: '1', username: 'test', email: 'test@test.com', role: 'admin',
      });

      await authenticate(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(authService.verifyToken).toHaveBeenCalledWith('my-jwt-token-here');
    });
  });

  describe('requireRole', () => {
    it('should return 401 when user is not authenticated', () => {
      const middleware = requireRole(['admin']);

      middleware(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Not authenticated' });
    });

    it('should return 403 when user role is not in allowed roles', () => {
      mockReq.user = { userId: '1', username: 'test', email: 'test@test.com', role: 'viewer' };
      const middleware = requireRole(['admin']);

      middleware(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
    });

    it('should call next() when user role matches', () => {
      mockReq.user = { userId: '1', username: 'admin', email: 'admin@test.com', role: 'admin' };
      const middleware = requireRole(['admin']);

      middleware(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should accept multiple allowed roles', () => {
      mockReq.user = { userId: '1', username: 'viewer', email: 'v@test.com', role: 'viewer' };
      const middleware = requireRole(['admin', 'viewer']);

      middleware(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('optionalAuth', () => {
    it('should call next() without setting user when no token provided', async () => {
      await optionalAuth(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should attach user when valid token is provided', async () => {
      const mockPayload = {
        userId: '123', username: 'testuser', email: 'test@test.com', role: 'admin',
      };
      mockReq.headers = { authorization: 'Bearer valid-token' };
      (authService.verifyToken as any).mockReturnValue(mockPayload);

      await optionalAuth(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockReq.user).toEqual(mockPayload);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should call next() without error when token is invalid', async () => {
      mockReq.headers = { authorization: 'Bearer bad-token' };
      (authService.verifyToken as any).mockImplementation(() => {
        throw new Error('Invalid token');
      });

      await optionalAuth(mockReq as AuthRequest, mockRes as Response, mockNext);

      expect(mockReq.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });
});
