import { describe, it, expect } from 'vitest';
import {
  addressesShareStreetNumber,
  normalizePostalForDedupeMatch,
  primaryStreetNumberTokenForSql,
} from '../../utils/address-street-match';

describe('address-street-match', () => {
  it('normalizes postal codes for comparison', () => {
    expect(normalizePostalForDedupeMatch('60025')).toBe('60025');
    expect(normalizePostalForDedupeMatch('60025-1234')).toBe('600251234');
    expect(normalizePostalForDedupeMatch('SW1A 1AA')).toBe('sw1a1aa');
  });

  it('primaryStreetNumberTokenForSql prefers longer numeric tokens', () => {
    expect(primaryStreetNumberTokenForSql('1200 North Milwaukee Avenue')).toBe('1200');
    expect(primaryStreetNumberTokenForSql('Suite 5, 60 Main Street')).toBe('60');
  });

  it('addressesShareStreetNumber requires overlap when both sides have numbers', () => {
    expect(addressesShareStreetNumber('1600 Water St', '5001 Expressway')).toBe(false);
    expect(addressesShareStreetNumber('1200 Milwaukee Ave', '1200 N Milwaukee')).toBe(true);
  });
});
