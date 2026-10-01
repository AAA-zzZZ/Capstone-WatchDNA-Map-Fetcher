import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// Mock Prisma - use a class-like constructor
vi.mock('@prisma/client', () => {
  const PrismaClient = vi.fn().mockImplementation(function(this: any) {
    this.user = {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    };
  });
  return { PrismaClient };
});

import { AuthService, JWTPayload } from '../../services/auth.service';

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-key-for-testing-only';
    process.env.JWT_EXPIRES_IN = '1h';
    authService = new AuthService();
  });

  describe('hashPassword', () => {
    it('should hash a password successfully', async () => {
      const password = 'mySecurePassword123';
      const hash = await authService.hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(0);
    });

    it('should generate different hashes for the same password', async () => {
      const password = 'testPassword';
      const hash1 = await authService.hashPassword(password);
      const hash2 = await authService.hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });

    it('should produce a bcrypt hash format', async () => {
      const hash = await authService.hashPassword('test');
      expect(hash).toMatch(/^\$2[ab]\$/);
    });
  });

  describe('comparePassword', () => {
    it('should return true for matching password', async () => {
      const password = 'correctPassword';
      const hash = await bcrypt.hash(password, 10);

      const result = await authService.comparePassword(password, hash);
      expect(result).toBe(true);
    });

    it('should return false for non-matching password', async () => {
      const hash = await bcrypt.hash('correctPassword', 10);

      const result = await authService.comparePassword('wrongPassword', hash);
      expect(result).toBe(false);
    });

    it('should return false for empty password against hash', async () => {
      const hash = await bcrypt.hash('somePassword', 10);

      const result = await authService.comparePassword('', hash);
      expect(result).toBe(false);
    });
  });

  describe('generateToken', () => {
    it('should generate a valid JWT token', () => {
      const payload: JWTPayload = {
        userId: '123',
        username: 'testuser',
        email: 'test@example.com',
        role: 'admin',
      };

      const token = authService.generateToken(payload);

      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3);
    });

    it('should include payload data in the token', () => {
      const payload: JWTPayload = {
        userId: '456',
        username: 'adminuser',
        email: 'admin@example.com',
        role: 'admin',
      };

      const token = authService.generateToken(payload);
      const decoded = jwt.decode(token) as any;

      expect(decoded.userId).toBe('456');
      expect(decoded.username).toBe('adminuser');
      expect(decoded.email).toBe('admin@example.com');
      expect(decoded.role).toBe('admin');
    });

    it('should set token expiration', () => {
      const payload: JWTPayload = {
        userId: '1', username: 'test', email: 'test@test.com', role: 'admin',
      };

      const token = authService.generateToken(payload);
      const decoded = jwt.decode(token) as any;

      expect(decoded.exp).toBeDefined();
      expect(decoded.iat).toBeDefined();
      expect(decoded.exp).toBeGreaterThan(decoded.iat);
    });
  });

  describe('verifyToken', () => {
    it('should verify and return payload for valid token', () => {
      const payload: JWTPayload = {
        userId: '123',
        username: 'testuser',
        email: 'test@example.com',
        role: 'admin',
      };

      const token = authService.generateToken(payload);
      const result = authService.verifyToken(token);

      expect(result.userId).toBe('123');
      expect(result.username).toBe('testuser');
      expect(result.role).toBe('admin');
    });

    it('should throw error for tampered token', () => {
      const token = authService.generateToken({
        userId: '1', username: 'test', email: 'test@test.com', role: 'admin',
      });

      const tamperedToken = token.slice(0, -5) + 'XXXXX';

      expect(() => authService.verifyToken(tamperedToken)).toThrow('Invalid or expired token');
    });

    it('should throw error for completely invalid token', () => {
      expect(() => authService.verifyToken('not-a-jwt-token')).toThrow('Invalid or expired token');
    });

    it('should throw error for expired token', () => {
      process.env.JWT_EXPIRES_IN = '0s';
      const shortLivedService = new AuthService();

      const token = shortLivedService.generateToken({
        userId: '1', username: 'test', email: 'test@test.com', role: 'admin',
      });

      expect(() => shortLivedService.verifyToken(token)).toThrow('Invalid or expired token');
    });

    it('should reject token signed with different secret', () => {
      const wrongToken = jwt.sign(
        { userId: '1', username: 'test', email: 'test@test.com', role: 'admin' },
        'different-secret-key',
        { expiresIn: '1h' }
      );

      expect(() => authService.verifyToken(wrongToken)).toThrow('Invalid or expired token');
    });
  });

  describe('constructor security warnings', () => {
    it('should warn when using default JWT secret', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      process.env.JWT_SECRET = 'default_secret_change_me';

      new AuthService();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Using default JWT secret')
      );
      warnSpy.mockRestore();
    });
  });
});
