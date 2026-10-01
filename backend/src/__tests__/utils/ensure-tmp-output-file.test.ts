import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ensureTmpOutputFile } from '../../controllers/scraper.controller';

const TMP_DIR = path.join(__dirname, '..', '..', '..', '..', 'tmp');

function cleanup(files: string[]) {
  for (const f of files) {
    try { fs.unlinkSync(f); } catch { /* already gone */ }
  }
}

describe('ensureTmpOutputFile', () => {
  afterEach(() => {
    // Leave tmp dir in place but remove any files created by tests below.
  });

  it('returns a path ending in .json', () => {
    const file = ensureTmpOutputFile('test');
    expect(file.endsWith('.json')).toBe(true);
    cleanup([file]);
  });

  it('creates the tmp directory if it does not exist', () => {
    // The directory may already exist; the function must not throw either way.
    expect(() => ensureTmpOutputFile('dir_check')).not.toThrow();
    expect(fs.existsSync(TMP_DIR)).toBe(true);
  });

  it('embeds the prefix in the filename', () => {
    const file = ensureTmpOutputFile('myprefix');
    expect(path.basename(file)).toMatch(/^myprefix_/);
    cleanup([file]);
  });

  // Bug 3 regression: rapid successive calls must produce unique paths.
  it('produces unique paths across 100 rapid successive calls', () => {
    const files = Array.from({ length: 100 }, () => ensureTmpOutputFile('probe'));
    const unique = new Set(files);
    expect(unique.size).toBe(100);
    cleanup(files);
  });

  it('produces unique paths when called concurrently via Promise.all', async () => {
    const files = await Promise.all(
      Array.from({ length: 50 }, () =>
        Promise.resolve(ensureTmpOutputFile('concurrent'))
      )
    );
    const unique = new Set(files);
    expect(unique.size).toBe(50);
    cleanup(files);
  });
});
