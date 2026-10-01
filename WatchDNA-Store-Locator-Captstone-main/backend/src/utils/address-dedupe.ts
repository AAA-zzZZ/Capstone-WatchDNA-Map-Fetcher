/** Min length for substring-style address fingerprint matching. */
export const MIN_ADDRESS_FP_CONTAIN_LEN = 8;

/** Strip combining marks so "Jean-Jaurès" and "Jean JAURES" align. */
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

/** Collapse hyphenated number groups: "1-1-43" → "1143" (JP/EU style vs spaced forms). */
function collapseHyphenatedStreetNumbers(s: string): string {
  let prev = '';
  let t = s;
  while (t !== prev) {
    prev = t;
    t = t.replace(/(\d)-(?=\d)/g, '$1');
  }
  return t;
}

/** Floor markers that split one geocode into multiple POIs (e.g. "11F ABENOSUJI"). */
const FLOOR_MARKER_RE = /\b\d{1,2}f\b|\bf-?\d{1,2}\b/gi;

function stripFloorMarkers(s: string): string {
  return s.replace(FLOOR_MARKER_RE, ' ');
}

/**
 * Suite / building / unit tokens so the same street number merges across "Suite 101" vs "BLDG C, UNIT 4".
 *
 * Handles:
 *  - "Suite 101", "STE 101"       — standard form (letter+number or number-only)
 *  - "STE #300", "Suite #5"       — hash prefix before the unit number
 *  - "STE. F-001", "Suite B-12"   — letter-hyphen-digit alphanumeric codes
 *  - "unit #4", "UNIT 4B"         — unit keyword variants
 *  - "BLDG C", "Building 3"       — building/bldg keyword variants
 *
 * Pattern anatomy for suite/ste:
 *   \b(?:suite|ste)  — keyword
 *   \.?              — optional trailing dot (e.g. "STE.")
 *   \s*#?\s*         — optional whitespace, optional "#", optional whitespace
 *   [a-z0-9]+        — first token (letter or digit run)
 *   (?:-[a-z0-9]+)*  — optional hyphenated segments (e.g. "F-001", "B-12")
 */
const SUBUNIT_RE =
  /\b(?:suite|ste)\.?\s*#?\s*[a-z0-9]+(?:-[a-z0-9]+)*\b|\bunit\s*#?\s*[a-z0-9]+(?:-[a-z0-9]+)*\b|\bbldg\.?\s*[a-z0-9]+\b|\bbuilding\s*[a-z0-9]+\b/gi;

function stripSubunitTokens(s: string): string {
  return s.replace(SUBUNIT_RE, ' ');
}

/**
 * Directionals often omitted between number and street ("1200 North Milwaukee" vs "1200 Milwaukee").
 * Do not strip "West"/"East" when they begin "West River …" / "East River …" — that is the street name.
 */
const DIRECTIONAL_EXCEPT_RIVER_RE =
  /\b(north|south|northeast|northwest|southeast|southwest|n\.?|s\.?|e\.?|w\.?)\b\.?/gi;

function stripDirectionalTokens(s: string): string {
  let t = s
    .replace(/\bwest\b(?!\s+river\b)/gi, ' ')
    .replace(/\beast\b(?!\s+river\b)/gi, ' ');
  t = t.replace(DIRECTIONAL_EXCEPT_RIVER_RE, ' ');
  return t;
}

/** "26 av Jean" / "26 ave." → avenue (FR). Avoid matching the start of the word "avenue". */
function expandAvTokensToAvenue(s: string): string {
  return s
    .replace(/\bave\.?\b(?!n)/gi, 'avenue ')
    .replace(/\bav\.?\b(?!e)/gi, 'avenue ');
}

/** Trailing commas (e.g. after stripping "UNIT 4,") so `… St` still matches trailing abbrev expansion. */
function trimTrailingCommasAndSpaces(s: string): string {
  return s.replace(/(?:\s|,)+$/g, '').trim();
}

const TRAILING_STREET_ABBREV: Record<string, string> = {
  st: 'street',
  ave: 'avenue',
  rd: 'road',
  blvd: 'boulevard',
  dr: 'drive',
  ln: 'lane',
  ct: 'court',
  pl: 'place',
  pkwy: 'parkway',
  cir: 'circle',
  hwy: 'highway',
  fwy: 'freeway',
  expy: 'expressway',
  sq: 'square',
  ter: 'terrace',
  trl: 'trail',
  aly: 'alley',
  bnd: 'bend',
  brg: 'bridge',
  holw: 'hollow',
  pt: 'point',
  xing: 'crossing',
};

/**
 * Expand trailing US-style street abbreviations so "513 Whitaker St" and "513 Whitaker Street"
 * share the same dedupe fingerprint. Requires a space before the token (end of line1).
 */
export function expandTrailingStreetAbbrevForDedupe(line1: string): string {
  const t = line1.trim().toLowerCase();
  return t.replace(/(\s)(st|ave|rd|blvd|dr|ln|ct|pl|pkwy|cir)\.?$/i, (_, sp: string, abbr: string) => {
    const full = TRAILING_STREET_ABBREV[abbr.toLowerCase()];
    return full ? `${sp}${full}` : `${sp}${abbr}`;
  });
}

/**
 * Strong address fingerprint for dedupe: accents, JP-style lot numbers, floors, directionals,
 * FR "av.", and US trailing St/Ave collapse before alnum-only.
 */
export function dedupeAddressFingerprint(line1: string): string {
  let t = line1.trim().toLowerCase();
  t = stripDiacritics(t);
  t = collapseHyphenatedStreetNumbers(t);
  t = stripFloorMarkers(t);
  t = stripSubunitTokens(t);
  t = stripDirectionalTokens(t);
  t = expandAvTokensToAvenue(t);
  t = trimTrailingCommasAndSpaces(t);
  t = expandTrailingStreetAbbrevForDedupe(t);
  return t.replace(/[^a-z0-9]+/g, '');
}

/**
 * True when one fingerprint plausibly extends the other (mall/suite text), not different street numbers.
 * Blocks e.g. "calleSerrano2" vs "calleSerrano26" (digit suffix only).
 */
export function safeAddressFingerprintContainment(fpA: string, fpB: string): boolean {
  if (fpA.length < MIN_ADDRESS_FP_CONTAIN_LEN || fpB.length < MIN_ADDRESS_FP_CONTAIN_LEN) {
    return false;
  }
  const [shorter, longer] = fpA.length <= fpB.length ? [fpA, fpB] : [fpB, fpA];
  if (!longer.includes(shorter)) return false;
  if (longer === shorter) return true;
  if (longer.startsWith(shorter)) {
    const rest = longer.slice(shorter.length);
    if (/\d$/.test(shorter) && /^\d+$/.test(rest)) return false;
  }
  return true;
}
