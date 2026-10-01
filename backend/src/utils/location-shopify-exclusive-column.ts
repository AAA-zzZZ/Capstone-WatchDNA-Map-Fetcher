import prisma from '../lib/prisma';

let exclusiveColumnExists: boolean | null = null;

/**
 * Whether `Location.shopifyStoreImageExclusiveUpload` exists in the connected database.
 */
export async function locationTableHasShopifyExclusiveUploadColumn(): Promise<boolean> {
  if (exclusiveColumnExists !== null) return exclusiveColumnExists;
  try {
    await prisma.$queryRawUnsafe(
      'SELECT "shopifyStoreImageExclusiveUpload" FROM "Location" LIMIT 1'
    );
    exclusiveColumnExists = true;
  } catch {
    exclusiveColumnExists = false;
  }
  return exclusiveColumnExists;
}
