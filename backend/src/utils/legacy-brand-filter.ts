import type { Prisma } from '@prisma/client';

import { brandConfigIdToDisplayName } from './brand-display-name';

/**
 * Prisma where-clause: match `Location.brands` or `customBrands` (substring, case-insensitive).
 * Uses display name from brand config id when the filter token differs (same rules as CSV export).
 */
export function legacyBrandTextFilterWhere(brandFilter: string): Prisma.LocationWhereInput {
  const raw = brandFilter.trim();
  const display = brandConfigIdToDisplayName(raw);
  const or: Prisma.LocationWhereInput[] = [
    { brands: { contains: display, mode: 'insensitive' } },
    { customBrands: { contains: display, mode: 'insensitive' } },
  ];
  if (raw.toLowerCase() !== display.toLowerCase()) {
    or.push(
      { brands: { contains: raw, mode: 'insensitive' } },
      { customBrands: { contains: raw, mode: 'insensitive' } }
    );
  }
  return { OR: or };
}
