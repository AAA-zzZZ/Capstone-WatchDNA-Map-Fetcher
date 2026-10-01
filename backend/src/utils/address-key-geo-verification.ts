import { normalizeCountry } from './country';

const squashSpaces = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Stable key for skipping re-geocode when address fields are unchanged.
 */
export function addressKeyForGeoVerification(input: {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
}): string {
  const country = squashSpaces(normalizeCountry(input.country));
  return [
    squashSpaces(input.addressLine1),
    squashSpaces(input.addressLine2 ?? ''),
    squashSpaces(input.city),
    squashSpaces(input.stateProvinceRegion ?? ''),
    squashSpaces(input.postalCode ?? ''),
    country,
  ].join('|');
}
