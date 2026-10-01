/**
 * Street-number overlap for conservative dedupe (same building vs different street numbers).
 */

export function normalizePostalForDedupeMatch(postalCode: string | null | undefined): string {
  return (postalCode ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Multi-digit tokens (2+ digits) — excludes single-digit unit noise. */
export function extractStreetNumbers(addr: string): Set<string> {
  const matches = addr.match(/\b\d{2,}\b/g);
  return new Set(matches ?? []);
}

/**
 * True if both addresses share at least one multi-digit number, or if one side has none
 * (cannot use numbers to distinguish).
 */
export function addressesShareStreetNumber(addrA: string, addrB: string): boolean {
  const numsA = extractStreetNumbers(addrA);
  const numsB = extractStreetNumbers(addrB);
  if (numsA.size === 0 || numsB.size === 0) return true;
  for (const n of numsA) {
    if (numsB.has(n)) return true;
  }
  return false;
}

/**
 * Prefer longer tokens (e.g. 1200 over 60) and 4+ digit numbers for SQL strpos prefilter
 * so dense cities get fewer false candidates.
 */
export function primaryStreetNumberTokenForSql(line1: string): string | null {
  const nums = [...extractStreetNumbers(line1)];
  if (nums.length === 0) return null;
  const fourPlus = nums.filter((n) => n.length >= 4);
  const pool = fourPlus.length > 0 ? fourPlus : nums;
  return pool.sort((a, b) => b.length - a.length)[0] ?? null;
}
