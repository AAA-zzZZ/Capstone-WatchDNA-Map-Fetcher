import { describe, it, expect } from 'vitest';
import {
  dedupeAddressFingerprint,
  expandTrailingStreetAbbrevForDedupe,
  safeAddressFingerprintContainment,
} from '../../utils/address-dedupe';
import { addressFingerprintLine1 } from '../../utils/stable-handle';

describe('expandTrailingStreetAbbrevForDedupe / dedupeAddressFingerprint', () => {
  it('normalizes St vs Street for the same line', () => {
    expect(expandTrailingStreetAbbrevForDedupe('513 Whitaker St')).toBe('513 whitaker street');
    expect(dedupeAddressFingerprint('513 WHITAKER STREET')).toBe('513whitakerstreet');
    expect(dedupeAddressFingerprint('513 Whitaker St')).toBe('513whitakerstreet');
  });

  it('aligns North Milwaukee vs Milwaukee and FR av. vs Avenue with accents', () => {
    expect(
      dedupeAddressFingerprint('1200 North Milwaukee Avenue, Glenview')
    ).toBe(dedupeAddressFingerprint('1200 Milwaukee Avenue, Glenview'));
    expect(dedupeAddressFingerprint('26 Avenue Jean-Jaurès')).toBe(
      dedupeAddressFingerprint('26 av Jean JAURES')
    );
  });

  it('keeps West in West River St and strips suites/units so same street number merges', () => {
    expect(dedupeAddressFingerprint('300 WEST RIVER ST, BLDG C, UNIT 4')).toBe(
      dedupeAddressFingerprint('300, Suite 101 West River Street')
    );
  });

  it('strips hash-prefixed suite numbers (STE #300, Suite #5)', () => {
    expect(dedupeAddressFingerprint('12300 Jefferson Avenue, STE #300')).toBe(
      dedupeAddressFingerprint('12300 Jefferson Avenue')
    );
    expect(dedupeAddressFingerprint('100 Main St Suite #5')).toBe(
      dedupeAddressFingerprint('100 Main Street')
    );
  });

  it('strips hyphenated alphanumeric suite codes (STE. F-001, Suite B-12)', () => {
    expect(dedupeAddressFingerprint('6600 Menaul Blvd. NE STE. F-001')).toBe(
      dedupeAddressFingerprint('6600 Menaul Blvd. NE')
    );
    expect(dedupeAddressFingerprint('500 Broadway Suite B-12')).toBe(
      dedupeAddressFingerprint('500 Broadway')
    );
  });

  it('strips hash-prefixed unit numbers (unit #4)', () => {
    expect(dedupeAddressFingerprint('200 Oak Ave unit #4')).toBe(
      dedupeAddressFingerprint('200 Oak Avenue')
    );
  });

  it('strips floor markers and collapses hyphenated lot numbers', () => {
    expect(dedupeAddressFingerprint('1-1-43 ABENOSUJI')).toBe(dedupeAddressFingerprint('1-1-43 11F ABENOSUJI'));
  });
});

describe('safeAddressFingerprintContainment', () => {
  it('allows mall / unit extensions', () => {
    const a = addressFingerprintLine1('Marina Mall');
    const b = addressFingerprintLine1('MARINA MALL 18 ST');
    expect(safeAddressFingerprintContainment(a, b)).toBe(true);
  });

  it('rejects different street numbers that share a digit prefix', () => {
    const a = addressFingerprintLine1('Calle Serrano 2');
    const b = addressFingerprintLine1('CALLE SERRANO 26');
    expect(safeAddressFingerprintContainment(a, b)).toBe(false);
  });
});
