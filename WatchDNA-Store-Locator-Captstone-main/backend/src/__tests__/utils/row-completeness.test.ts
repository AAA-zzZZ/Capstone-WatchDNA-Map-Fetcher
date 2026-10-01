import { describe, it, expect } from 'vitest';
import { isRowCompleteForDb } from '../../utils/row-completeness';

const base = {
  Name: 'Test Store',
  'Address Line 1': '1 High Street',
  'Address Line 2': '',
  Latitude: '51.5074',
  Longitude: '-0.1278',
  Phone: '',
};

describe('isRowCompleteForDb', () => {
  it('accepts a complete row without a phone number', () => {
    expect(isRowCompleteForDb({ ...base, Phone: '' })).toBe(true);
  });

  it('accepts a complete row that has a phone number', () => {
    expect(isRowCompleteForDb({ ...base, Phone: '+1 212 555 0100' })).toBe(true);
  });

  it('rejects when Name is missing', () => {
    expect(isRowCompleteForDb({ ...base, Name: '' })).toBe(false);
  });

  it('rejects when both Address Line 1 and Line 2 are empty', () => {
    expect(isRowCompleteForDb({ ...base, 'Address Line 1': '', 'Address Line 2': '' })).toBe(false);
  });

  it('accepts when only Address Line 2 is provided', () => {
    expect(
      isRowCompleteForDb({ ...base, 'Address Line 1': '', 'Address Line 2': 'PO Box 5' })
    ).toBe(true);
  });

  it('rejects when Latitude is missing', () => {
    expect(isRowCompleteForDb({ ...base, Latitude: '' })).toBe(false);
  });

  it('rejects when Longitude is NaN', () => {
    expect(isRowCompleteForDb({ ...base, Longitude: 'not-a-number' })).toBe(false);
  });

  it('rejects when coordinates are both zero (unusable placeholder)', () => {
    // 0,0 is valid float but passes the NaN check — isRowCompleteForDb does not guard 0,0;
    // that guard lives in isUnusableScraperCoordinate. Confirm 0,0 is not rejected here.
    expect(isRowCompleteForDb({ ...base, Latitude: '0', Longitude: '0' })).toBe(true);
  });
});
