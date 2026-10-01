/** Shared shape for forward geocoding (Nominatim, Photon, etc.). */
export type GeocodeAddressInput = {
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  stateProvinceRegion: string | null;
  postalCode: string | null;
  country: string;
};

export function buildStreetLineForGeocode(line1: string, line2: string | null): string {
  const a = line1.trim();
  const b = (line2 ?? '').trim();
  if (!b) return a;
  return `${a}, ${b}`;
}

/** Single-line query from structured address fields. */
export function buildFreeformGeocodeQuery(input: GeocodeAddressInput): string | null {
  const parts = [
    buildStreetLineForGeocode(input.addressLine1, input.addressLine2),
    (input.city ?? '').trim(),
    (input.stateProvinceRegion ?? '').trim(),
    (input.postalCode ?? '').trim(),
    (input.country ?? '').trim(),
  ].filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.join(', ');
}
