import { describe, it, expect } from 'vitest';

import {
  STORE_IMAGE_PUBLIC_PREFIX,
  isValidStoreImageFilename,
  managedImageFilenameFromUrl,
} from '../../utils/store-premium-image';

const SAMPLE_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('store-premium-image', () => {
  it('validates safe uploaded filenames', () => {
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.jpg`)).toBe(true);
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.jpeg`)).toBe(true);
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.png`)).toBe(true);
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.webp`)).toBe(true);
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.gif`)).toBe(true);
    expect(isValidStoreImageFilename('../../../etc/passwd')).toBe(false);
    expect(isValidStoreImageFilename(`${SAMPLE_UUID}.exe`)).toBe(false);
    expect(isValidStoreImageFilename('not-a-uuid.jpg')).toBe(false);
  });

  it('extracts managed filename from stored imageUrl', () => {
    expect(managedImageFilenameFromUrl(`${STORE_IMAGE_PUBLIC_PREFIX}${SAMPLE_UUID}.png`)).toBe(
      `${SAMPLE_UUID}.png`
    );
    expect(managedImageFilenameFromUrl('https://cdn.example.com/x.jpg')).toBeNull();
    expect(managedImageFilenameFromUrl(`${STORE_IMAGE_PUBLIC_PREFIX}../x.jpg`)).toBeNull();
  });
});
