import prisma from '../lib/prisma';

let locationBrandFilterColumnExists: boolean | null = null;

/**
 * Whether `Location.brandFilterMode` exists in the connected database.
 * Cached for the process lifetime so we do not probe on every query.
 */
export async function locationTableHasBrandFilterModeColumn(): Promise<boolean> {
  if (locationBrandFilterColumnExists !== null) return locationBrandFilterColumnExists;
  try {
    await prisma.$queryRawUnsafe('SELECT "brandFilterMode" FROM "Location" LIMIT 1');
    locationBrandFilterColumnExists = true;
  } catch {
    locationBrandFilterColumnExists = false;
  }
  return locationBrandFilterColumnExists;
}
