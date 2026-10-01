/**
 * Security Headers Middleware
 * Adds production-grade security headers to all responses
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Security headers middleware
 * Adds headers to protect against common web vulnerabilities
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Prevent clickjacking attacks
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Enable XSS protection (legacy browsers)
  res.setHeader('X-XSS-Protection', '1; mode=block');

  // Control referrer information
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Content Security Policy (CSP)
  // Restrict what resources the browser can load
  if (config.isProduction) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self'; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'"
    );
  }

  // Permissions Policy (formerly Feature Policy)
  // Allow geolocation for this origin (needed for "Near Me" feature)
  // Disable other unused browser features
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(self), microphone=(), camera=(), payment=()'
  );

  // Strict Transport Security (HTTPS only)
  // Only add in production when HTTPS is available
  if (config.isProduction) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains; preload'
    );
  }

  next();
}
