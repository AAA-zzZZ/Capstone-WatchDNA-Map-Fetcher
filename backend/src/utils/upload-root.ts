import path from 'path';

/** Directory containing `dist/` (backend package root) when running compiled code. */
function backendPackageRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Absolute directory for CSV uploads, premium store images, and scraper output.
 *
 * Resolution order:
 * 1. `UPLOAD_DIR` — absolute path or path relative to the backend package root
 * 2. `RAILWAY_VOLUME_MOUNT_PATH` — Railway sets this to your volume mount path (use as upload root)
 * 3. `<backend>/uploads` — local default
 */
export function resolveUploadRootDir(): string {
  const raw = process.env.UPLOAD_DIR?.trim();
  if (raw) {
    if (path.isAbsolute(raw)) return raw;
    const rel = raw.replace(/^\.\//, '');
    return path.resolve(backendPackageRoot(), rel);
  }
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim();
  if (vol) {
    return vol;
  }
  return path.join(backendPackageRoot(), 'uploads');
}
