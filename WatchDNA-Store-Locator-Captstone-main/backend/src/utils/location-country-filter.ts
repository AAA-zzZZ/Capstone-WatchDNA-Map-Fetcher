import type { Prisma } from '@prisma/client';

import { normalizeCountry } from './country';

/**
 * Exact `Location.country` match using the same rule as `GET /api/locations?country=`.
 * `normalizeCountry(trimmed) || trimmed` so aliases and ISO codes resolve consistently.
 */
export function locationCountryEqualsWhere(raw: string | undefined | null): Prisma.LocationWhereInput | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  return { country: normalizeCountry(t) || t };
}
