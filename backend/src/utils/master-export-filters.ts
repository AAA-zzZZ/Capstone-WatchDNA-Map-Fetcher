import type { Prisma } from '@prisma/client';

import { legacyBrandTextFilterWhere } from './legacy-brand-filter';
import { locationCountryEqualsWhere } from './location-country-filter';

export type MasterExportFilters = {
  brand?: string;
  country?: string;
  /** When true, only rows with `Location.isPremium`. */
  premiumOnly?: boolean;
};

export function buildMasterExportWhere(filters?: MasterExportFilters): Prisma.LocationWhereInput {
  const clauses: Prisma.LocationWhereInput[] = [];
  const brand = filters?.brand?.trim();
  if (brand) clauses.push(legacyBrandTextFilterWhere(brand));
  const countryClause = locationCountryEqualsWhere(filters?.country);
  if (countryClause) clauses.push(countryClause);
  if (filters?.premiumOnly) clauses.push({ isPremium: true });
  if (clauses.length === 0) return {};
  if (clauses.length === 1) return clauses[0]!;
  return { AND: clauses };
}
