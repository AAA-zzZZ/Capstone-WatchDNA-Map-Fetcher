// Ensure .env is applied before Prisma reads DATABASE_URL (import order can otherwise
// instantiate the client with a stale env, e.g. postgres.railway.internal from the shell).
import '../load-env';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;
