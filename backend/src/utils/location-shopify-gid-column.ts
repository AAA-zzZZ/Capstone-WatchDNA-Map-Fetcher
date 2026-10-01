import prisma from '../lib/prisma';

let shopifyGidColumnExists: boolean | null = null;

/**
 * Whether `Location.shopifyFileGid` exists in the connected database.
 * Cached for the process lifetime so we do not probe on every query.
 */
export async function locationTableHasShopifyFileGidColumn(): Promise<boolean> {
  if (shopifyGidColumnExists !== null) return shopifyGidColumnExists;
  try {
    await prisma.$queryRawUnsafe('SELECT "shopifyFileGid" FROM "Location" LIMIT 1');
    shopifyGidColumnExists = true;
  } catch {
    shopifyGidColumnExists = false;
  }
  return shopifyGidColumnExists;
}
