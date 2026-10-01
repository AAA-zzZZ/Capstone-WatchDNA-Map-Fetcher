import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';

describe('resolveUploadRootDir', () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...original };
    delete process.env.UPLOAD_DIR;
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  });

  afterEach(() => {
    process.env = { ...original };
  });

  it('uses absolute UPLOAD_DIR when set', async () => {
    process.env.UPLOAD_DIR = '/data/uploads';
    const { resolveUploadRootDir } = await import('../../utils/upload-root');
    expect(resolveUploadRootDir()).toBe('/data/uploads');
  });

  it('uses RAILWAY_VOLUME_MOUNT_PATH when UPLOAD_DIR unset', async () => {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/railway/vol';
    const { resolveUploadRootDir } = await import('../../utils/upload-root');
    expect(resolveUploadRootDir()).toBe('/railway/vol');
  });

  it('prefers UPLOAD_DIR over RAILWAY_VOLUME_MOUNT_PATH', async () => {
    process.env.UPLOAD_DIR = '/custom';
    process.env.RAILWAY_VOLUME_MOUNT_PATH = '/railway/vol';
    const { resolveUploadRootDir } = await import('../../utils/upload-root');
    expect(resolveUploadRootDir()).toBe('/custom');
  });

  it('defaults to backend package uploads folder', async () => {
    const { resolveUploadRootDir } = await import('../../utils/upload-root');
    const root = resolveUploadRootDir();
    expect(root).toBe(path.join(path.resolve(__dirname, '..', '..', '..'), 'uploads'));
  });
});
