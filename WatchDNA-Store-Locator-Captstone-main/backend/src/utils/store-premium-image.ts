import fs from 'fs/promises';
import path from 'path';

import { config } from '../config';

/** Stored in Location.imageUrl for uploads served by GET /api/premium-stores/images/:filename */
export const STORE_IMAGE_PUBLIC_PREFIX = '/api/premium-stores/images/';

const FILENAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|webp|gif)$/i;

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const STORE_IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

function uploadRootDir(): string {
  const dir = config.upload.dir.replace(/^\.\//, '');
  return path.join(__dirname, '..', '..', dir);
}

export function storeImagesAbsoluteDir(): string {
  return path.join(uploadRootDir(), 'store-images');
}

export function isValidStoreImageFilename(name: string): boolean {
  return FILENAME_RE.test(name);
}

/** Returns the on-disk filename if `url` points at our managed store image route, else null. */
export function managedImageFilenameFromUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== 'string') return null;
  const t = url.trim();
  if (!t.startsWith(STORE_IMAGE_PUBLIC_PREFIX)) return null;
  const rest = t.slice(STORE_IMAGE_PUBLIC_PREFIX.length);
  if (rest.includes('/') || rest.includes('..')) return null;
  return isValidStoreImageFilename(rest) ? rest : null;
}

export function storeImageAbsolutePath(filename: string): string | null {
  if (!isValidStoreImageFilename(filename)) return null;
  const dir = storeImagesAbsoluteDir();
  const abs = path.resolve(path.join(dir, filename));
  const root = path.resolve(dir);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

export function contentTypeForStoreImageFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

export async function removeStoreImageFile(filename: string): Promise<void> {
  const abs = storeImageAbsolutePath(filename);
  if (!abs) return;
  await fs.unlink(abs);
}
