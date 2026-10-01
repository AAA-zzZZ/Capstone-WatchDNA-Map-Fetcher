import fs from 'fs';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';

import { shopifyFilesConfigured } from '../services/shopify-files.service';
import {
  STORE_IMAGE_MIME_TO_EXT,
  storeImagesAbsoluteDir,
} from '../utils/store-premium-image';

const MAX_BYTES = 5 * 1024 * 1024;

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = storeImagesAbsoluteDir();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = STORE_IMAGE_MIME_TO_EXT[file.mimetype] ?? '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (STORE_IMAGE_MIME_TO_EXT[file.mimetype]) {
    cb(null, true);
    return;
  }
  cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
};

/** Disk when Shopify uploads are off (default); memory when SHOPIFY_* env is set so we can stream to Shopify. */
export const premiumImageUpload = multer({
  storage: shopifyFilesConfigured() ? multer.memoryStorage() : diskStorage,
  fileFilter,
  limits: { fileSize: MAX_BYTES },
});

export function premiumImageUploadHandler(req: Request, res: Response, next: NextFunction): void {
  premiumImageUpload.single('image')(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Image too large (max 5 MB)' });
        return;
      }
      res.status(400).json({ error: err.message });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Invalid upload';
    res.status(400).json({ error: msg });
  });
}
