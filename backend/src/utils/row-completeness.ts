/**
 * Rows must meet this bar to be written to Location (scraper + strict CSV import).
 * Incomplete rows can remain on the job CSV and be fixed in the admin job editor.
 *
 * Required: non-empty Name, valid Latitude + Longitude, and at least one of Address Line 1 / Line 2.
 * Phone is intentionally optional — stores without a phone can still be added; operators can fill
 * it in when promoting a store to premium.
 */
export function isRowCompleteForDb(row: Record<string, string>): boolean {
  const addr1 = (row['Address Line 1'] ?? '').trim();
  const addr2 = (row['Address Line 2'] ?? '').trim();
  const name = (row.Name ?? '').trim();
  const lat = parseFloat(String(row.Latitude ?? ''));
  const lon = parseFloat(String(row.Longitude ?? ''));

  if (!name) return false;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return false;
  if (!addr1 && !addr2) return false;
  return true;
}
