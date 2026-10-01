import { describe, expect, it } from 'vitest';
import { parseRowToLocationData } from '../../utils/csv-to-location';

function baseRow(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    Handle: 'legacy-handle',
    Name: 'Omega Boutique',
    Status: 'active',
    'Address Line 1': '1 Place Vendome',
    'Address Line 2': '',
    City: 'Paris',
    'State/Province/Region': '',
    Country: 'France',
    'Postal/ZIP Code': '75001',
    Phone: '',
    Email: '',
    Website: '',
    Latitude: '48.86701',
    Longitude: '2.32877',
    Brands: '',
    Tags: '',
    ...overrides,
  };
}

describe('parseRowToLocationData', () => {
  it('uses provided Handle when present', () => {
    const parsed = parseRowToLocationData(baseRow({ Handle: 'my-source-id' }));
    expect(parsed).not.toBeNull();
    expect(parsed?.handle).toBe('my-source-id');
  });

  it('generates deterministic loc_* handle when Handle is missing', () => {
    const parsedA = parseRowToLocationData(baseRow({ Handle: '' }));
    const parsedB = parseRowToLocationData(baseRow({ Handle: '' }));

    expect(parsedA).not.toBeNull();
    expect(parsedB).not.toBeNull();
    expect(parsedA?.handle).toMatch(/^loc_[a-f0-9]{24}$/);
    expect(parsedA?.handle).toBe(parsedB?.handle);
  });
});
