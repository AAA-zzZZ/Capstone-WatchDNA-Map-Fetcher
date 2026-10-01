/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse and DoS attacks
 */

import rateLimit from 'express-rate-limit';
import { config } from '../config';

/**
 * General API rate limiter
 * Applied to all /api/* routes
 *
 * Default: 100 requests per 15 minutes per IP
 */
export const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.maxRequests,
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: 'Check the Retry-After header for when you can retry.',
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip rate limiting for development (optional - comment out to test in dev)
  skip: () => config.isDevelopment,
});

/**
 * Strict rate limiter for authentication endpoints
 * Prevents brute force attacks on login
 *
 * 5 attempts per 15 minutes per IP
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 login attempts
  message: {
    error: 'Too many login attempts from this IP, please try again after 15 minutes.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Always enforce auth rate limiting, even in development
  skip: () => false,
});

/**
 * Lenient rate limiter for public endpoints
 * Applied to location queries (public-facing map)
 *
 * 300 requests per 15 minutes per IP
 */
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // Higher limit for public queries
  message: {
    error: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip for development
  skip: () => config.isDevelopment,
});

/**
 * Strict rate limiter for upload endpoints
 * Prevents spam uploads
 *
 * 10 uploads per hour per IP
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 uploads per hour
  message: {
    error: 'Upload limit exceeded. Please wait before uploading more files.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isDevelopment,
});

/**
 * Rate limiter for analytics event ingestion
 * From mobile app — generous but bounded
 *
 * 200 requests per 15 minutes per IP
 */
export const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: {
    error: 'Analytics rate limit exceeded. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isDevelopment,
});

/**
 * Lenient rate limiter for the geocode-address endpoint.
 * This is a lightweight lookup used by admin forms — 60 per 15 min is plenty
 * for normal use without blocking an admin who clicks "Detect from address" repeatedly.
 *
 * 60 requests per 15 minutes per IP
 */
export const geocodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  message: {
    error: 'Geocode lookup limit exceeded. Please wait a moment before trying again.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isDevelopment,
});

/**
 * Rate limiter for scraper job creation
 * Prevents excessive scraper jobs
 *
 * 20 jobs per hour per IP
 */
export const scraperLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 scraper jobs per hour
  message: {
    error: 'Scraper job limit exceeded. Please wait before creating more jobs.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.isDevelopment,
});
