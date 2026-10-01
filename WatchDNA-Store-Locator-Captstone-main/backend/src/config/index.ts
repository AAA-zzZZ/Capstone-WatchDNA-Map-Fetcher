/**
 * Centralized configuration management
 * All environment variables are accessed through this module
 */

export const config = {
  // Server configuration
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDevelopment: process.env.NODE_ENV === 'development',
  isProduction: process.env.NODE_ENV === 'production',

  // Database configuration
  database: {
    url: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL,
  },

  // Authentication configuration
  auth: {
    jwtSecret: process.env.JWT_SECRET!,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Upload configuration
  upload: {
    dir: process.env.UPLOAD_DIR || './uploads',
    maxSize: 10 * 1024 * 1024, // 10MB
  },

  // Python configuration
  python: {
    path: process.env.PYTHON_PATH || 'python3',
  },

  // CORS configuration
  cors: {
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173'],
  },

  // Rate limiting configuration
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10), // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },

  // Error monitoring configuration
  sentry: {
    dsn: process.env.SENTRY_DSN,
    enabled: !!process.env.SENTRY_DSN,
  },

  // Optional services
  mapbox: {
    token: process.env.MAPBOX_SECRET,
  },

  /**
   * Optional: upload premium store images to Shopify Admin → Content → Files (CDN URL in DB).
   * Set SHOPIFY_STORE_DOMAIN + either:
   * - SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard client_credentials; token auto-refreshed), or
   * - SHOPIFY_ADMIN_ACCESS_TOKEN (static override, e.g. local dev).
   * Scope write_files (or write_images) required on the app version.
   */
  shopify: {
    storeDomain: process.env.SHOPIFY_STORE_DOMAIN || '',
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '',
    clientId: process.env.SHOPIFY_CLIENT_ID || '',
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || '',
    adminApiVersion: process.env.SHOPIFY_ADMIN_API_VERSION || '2025-10',
  },
} as const;

/**
 * Validates required environment variables in production
 * Throws an error if any required variables are missing
 */
export function validateConfig(): void {
  if (config.isProduction) {
    const required: Array<{ key: string; value: any }> = [
      { key: 'DATABASE_URL', value: process.env.DATABASE_URL },
      { key: 'JWT_SECRET', value: process.env.JWT_SECRET },
      { key: 'ALLOWED_ORIGINS', value: process.env.ALLOWED_ORIGINS },
    ];

    const missing = required.filter((env) => !env.value);

    if (missing.length > 0) {
      const missingKeys = missing.map((env) => env.key).join(', ');
      throw new Error(
        `Missing required environment variables for production: ${missingKeys}\n` +
          'Please set these variables in your .env file or hosting platform.'
      );
    }

    // Validate JWT_SECRET strength in production
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters long in production.\n' +
          'Generate a strong secret using: openssl rand -base64 32'
      );
    }

    // Warn about development defaults
    if (process.env.JWT_SECRET === 'change_this_to_random_secret_in_production') {
      throw new Error(
        'CRITICAL: You are using the default JWT_SECRET in production!\n' +
          'Generate a secure secret immediately: openssl rand -base64 32'
      );
    }
  }

  // Validate database URL format
  if (!config.database.url) {
    throw new Error('DATABASE_URL is required but not set');
  }

  console.log('✅ Configuration validated successfully');
}
