/**
 * Effective brands string for display / export when data may include legacy `brands` CSV only.
 * (Normalized Brand ↔ Location tables are optional; see prisma migration note in schema.prisma.)
 */

export type LocationBrandsSource = {
  brands?: string | null;
  /** Optional linked brands (tests / future normalized reads). */
  locationBrands?: Array<{ brand: { displayName: string } }>;
};

/**
 * CSV for merge/export: prefer linked brand display names when present; else legacy `brands` column.
 */
export function effectiveBrandsCsvFromLocation(loc: LocationBrandsSource): string | null {
  if (loc.locationBrands && loc.locationBrands.length > 0) {
    const names = [...new Set(loc.locationBrands.map((lb) => lb.brand.displayName))].sort((a, b) =>
      a.localeCompare(b)
    );
    return names.join(', ') || null;
  }
  return loc.brands ?? null;
}
