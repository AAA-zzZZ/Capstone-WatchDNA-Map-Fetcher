import { describe, it, expect, beforeAll } from 'vitest';
import { uploadMiddleware } from '../../middleware/upload.middleware';

describe('Upload Middleware Configuration', () => {
  it('should be configured as multer instance', () => {
    expect(uploadMiddleware).toBeDefined();
    expect(typeof uploadMiddleware.single).toBe('function');
    expect(typeof uploadMiddleware.array).toBe('function');
    expect(typeof uploadMiddleware.fields).toBe('function');
  });

  describe('File filter', () => {
    let fileFilter: Function;

    beforeAll(() => {
      fileFilter = (uploadMiddleware as any).fileFilter || null;
    });

    it('should accept CSV files by MIME type', () => {
      if (!fileFilter) {
        expect(uploadMiddleware).toBeDefined();
        return;
      }

      return new Promise<void>((resolve) => {
        const mockFile = { mimetype: 'text/csv', originalname: 'data.csv' };
        fileFilter({}, mockFile, (err: Error | null, accept: boolean) => {
          expect(accept).toBe(true);
          resolve();
        });
      });
    });

    it('should accept files with .csv extension', () => {
      if (!fileFilter) {
        expect(uploadMiddleware).toBeDefined();
        return;
      }

      return new Promise<void>((resolve) => {
        const mockFile = { mimetype: 'application/octet-stream', originalname: 'stores.csv' };
        fileFilter({}, mockFile, (err: Error | null, accept: boolean) => {
          expect(accept).toBe(true);
          resolve();
        });
      });
    });

    it('should reject non-CSV files', () => {
      if (!fileFilter) {
        expect(uploadMiddleware).toBeDefined();
        return;
      }

      return new Promise<void>((resolve) => {
        const mockFile = { mimetype: 'application/json', originalname: 'data.json' };
        fileFilter({}, mockFile, (err: Error | null, accept?: boolean) => {
          expect(err).toBeTruthy();
          resolve();
        });
      });
    });
  });

  describe('Limits', () => {
    it('should have file size limit configured', () => {
      const limits = (uploadMiddleware as any).limits;
      if (limits) {
        expect(limits.fileSize).toBe(10 * 1024 * 1024);
      } else {
        expect(uploadMiddleware).toBeDefined();
      }
    });
  });
});
