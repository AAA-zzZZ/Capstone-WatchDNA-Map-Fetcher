import { describe, it, expect } from 'vitest';
import {
  addressFingerprintLine1,
  computeStableHandleFromRow,
  computeNameScopedHandleFromRow,
} from '../../utils/stable-handle';

/**
 * Fingerprints align with store dedupe SQL (ASCII [^a-z0-9] strip).
 * See address-dedupe.test.ts for containment safety rules.
 */
describe('addressFingerprintLine1 (dedupe)', () => {
  it('strips punctuation and case like analyze-duplicates SQL', () => {
    expect(addressFingerprintLine1('3111 W. Chandler Blvd')).toBe('3111wchandlerblvd');
    expect(addressFingerprintLine1('The Dubai Mall')).toBe('thedubaimall');
  });

  it('models mall / suite variants that substring dedupe should merge', () => {
    const a = addressFingerprintLine1('Marina Mall');
    const b = addressFingerprintLine1('MARINA MALL 18 ST');
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(b.includes(a)).toBe(true);
  });
});

describe('computeNameScopedHandleFromRow', () => {
  const row = {
    Name: 'IWC Boutique',
    'Address Line 1': 'Allée François Blanc',
    'Address Line 2': '',
    City: 'Monte-Carlo',
    Country: 'Monaco',
    Latitude: '43.7392',
    Longitude: '7.4278',
  };

  it('differs from the address-only handle and is deterministic', () => {
    const base = computeStableHandleFromRow(row);
    const scoped = computeNameScopedHandleFromRow(row);
    expect(scoped).not.toBe(base);
    expect(scoped).toBe(computeNameScopedHandleFromRow({ ...row }));
    expect(scoped).toMatch(/^loc_[0-9a-f]{24}$/);
  });

  it('gives different-named boutiques at one address different handles', () => {
    const omega = computeNameScopedHandleFromRow({ ...row, Name: 'Omega Boutique' });
    expect(omega).not.toBe(computeNameScopedHandleFromRow(row));
  });
});
