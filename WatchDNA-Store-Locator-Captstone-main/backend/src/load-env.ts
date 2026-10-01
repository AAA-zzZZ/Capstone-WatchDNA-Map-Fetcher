import dotenv from 'dotenv';
import path from 'path';

const envPath = path.resolve(process.cwd(), '.env');

// Load before Prisma or any module that reads process.env.
// In development, .env wins over inherited shell vars (e.g. DATABASE_URL from `railway run`).
dotenv.config({
  path: envPath,
  override: process.env.NODE_ENV !== 'production',
});

// Private Railway hostname is unreachable from a local machine; if something still set it
// (e.g. NODE_ENV=production in the shell while developing), re-apply .env in non-production.
const dbUrl = process.env.DATABASE_URL || '';
if (
  process.env.NODE_ENV !== 'production' &&
  dbUrl.includes('railway.internal') &&
  dbUrl.includes('postgres')
) {
  dotenv.config({ path: envPath, override: true });
}
