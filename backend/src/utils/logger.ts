/**
 * Minimal logger that reduces noise in production.
 *
 * In production:  only ERROR and WARN reach stdout; INFO/DEBUG are suppressed.
 * In development: all levels reach stdout.
 *
 * The scraper stores its full output in the ScraperJob.logs DB column, so
 * suppressing stdout in production does not lose any visibility — you can
 * always read job logs from the admin console.
 *
 * Use logger.integration() for external systems you need to trace in production
 * (e.g. Shopify uploads); those lines always go to stdout.
 */

const isProd = process.env.NODE_ENV === 'production';

export const logger = {
  /** Always shown — critical failures */
  error: (...args: any[]) => console.error(...args),

  /** Always shown — unexpected conditions worth investigating */
  warn: (...args: any[]) => console.warn(...args),

  /**
   * Shown in all environments — use for high-signal integration events you need in production logs
   * (e.g. Railway) without enabling full info noise.
   */
  integration: (...args: any[]) => console.log(...args),

  /** Shown in dev only — high-frequency operational messages */
  info: (...args: any[]) => {
    if (!isProd) console.log(...args);
  },

  /** Shown in dev only — verbose/trace output */
  debug: (...args: any[]) => {
    if (!isProd) console.log(...args);
  },
};
