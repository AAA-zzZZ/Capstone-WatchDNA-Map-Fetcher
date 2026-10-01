/**
 * Normalize brand config IDs (e.g. omega_stores, accutron_stores) to display labels
 * (e.g. OMEGA, ACCUTRON) for CSV Brands column, DB, and admin UI parity.
 */

const SUFFIXES = ['_stores', '_retailers', '_dealers', '_watches'] as const;

/** True if token looks like a brand config key accidentally stored in Tags. */
export function looksLikeBrandConfigId(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  return SUFFIXES.some((s) => t.toLowerCase().endsWith(s));
}

const DISPLAY_OVERRIDES: Record<string, string> = {
  // Ampersand / special character brands
  'ALANGE SOEHNE': 'A. LANGE & SÖHNE',
  'BAUME ET MERCIER': 'BAUME & MERCIER',
  'BELL ROSS': 'BELL & ROSS',
  // Accented name variants
  'FREDERIQUE CONSTANT': 'FRÉDÉRIQUE CONSTANT',
  'FREDERIQUE-CONSTANT': 'FRÉDÉRIQUE CONSTANT',
  // Umlaut variants
  'GLASHUTTE': 'GLASHÜTTE',
  'GLASHUTTE ORIGINAL': 'GLASHÜTTE ORIGINAL',
  'MUHLE GLASHUTTE': 'MUHLE GLASHÜTTE',
  'NOMOS GLASHUTTE': 'NOMOS GLASHÜTTE',
  'UNION GLASHUTTE': 'UNION GLASHÜTTE',
  // Misspellings
  'TOMMY HILFINGER': 'TOMMY HILFIGER',
  // Config-key / spelling variants that would otherwise not merge with canonical names
  'TAGHEUER': 'TAG HEUER',
  'TAG-HEUER': 'TAG HEUER',
  'BAUME MERCIER': 'BAUME & MERCIER',
  'CITIZEN WATCH': 'CITIZEN',
  'BALL WATCH': 'BALL',
  'BALL WATCHES': 'BALL',
  // Hyphen/no-hyphen
  'UBOAT': 'U-BOAT',
  // Regional suffix variants
  'GRAHAM OF LONDON': 'GRAHAM',
};

/** Strip simple HTML so scraper/CSV glitches in the Brands column do not show as filter tokens. */
function stripSimpleHtml(s: string): string {
  let t = s.replace(/<[^>]+>/g, '');
  // Unclosed tag (e.g. truncated "<A HREF=\"...\") — remove from `<` through end of token
  t = t.replace(/<[^>]*$/gi, '');
  return t;
}

/** Leading fragments from broken anchor markup: \">FLIK FLAK */
function stripLeadingMarkupJunk(s: string): string {
  return s
    .replace(/^["']+\s*>\s*/g, '')
    .replace(/^>\s*/g, '')
    .trim();
}

/** Residual scraped link text — not a displayable brand token. */
function looksLikeHtmlOrUrlGarbage(upper: string): boolean {
  if (!upper) return true;
  if (/\bHREF\s*=/.test(upper)) return true;
  if (/HTTPS?:\/\//.test(upper)) return true;
  if (/[<>]/.test(upper)) return true;
  return false;
}

/**
 * Heuristic: "88 RUE DU RHONE" style values (street lines mistaken for a brand at ingest).
 * Applied after case normalization; keep conservative to avoid dropping real watch names.
 */
function looksLikeAddressLine(upper: string): boolean {
  // Starts with 1-5 digit street number, then text containing a common street token
  // (French/Italian/English/Latin) — not typical watch brand phrasing
  if (!/^\d{1,5}\s+/.test(upper)) return false;
  return /\b(RUE|RUA|VIA|VIALE|CORSO|PIAZZA|C\/|STREET|ST\.|AVENUE|ROAD|BLVD|BOULEVARD|LANE|DRIVE|WAY|COURT|CARRER)\b/i.test(upper);
}

/**
 * Single brand token or config id → ALL CAPS display name, no _stores suffix.
 * Returns '' for tokens that contain no alphanumeric characters (e.g. bare "-"),
 * and strips HTML that was accidentally stored in the brands column.
 */
export function brandConfigIdToDisplayName(brandId: string): string {
  let name = stripLeadingMarkupJunk(stripSimpleHtml(brandId)).trim();
  if (!name) return '';
  for (const suf of SUFFIXES) {
    const low = name.toLowerCase();
    if (low.endsWith(suf)) {
      name = name.slice(0, -suf.length);
      break;
    }
  }
  name = name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!name) return '';
  // Reject tokens that are purely punctuation/symbols (e.g. "-")
  if (!/[A-Z0-9]/i.test(name)) return '';
  if (looksLikeAddressLine(name)) return '';
  if (looksLikeHtmlOrUrlGarbage(name)) return '';
  return DISPLAY_OVERRIDES[name] ?? name;
}

/**
 * Comma-separated Brands column: each token normalized, case-insensitive dedupe.
 */
export function normalizeBrandsCsvField(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const tokens = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const display = brandConfigIdToDisplayName(t);
    if (!display) continue;
    const key = display.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(display);
  }
  return out.length ? out.join(', ') : null;
}

/**
 * Remove one brand (any spelling variant of it) from a comma-separated Brands field.
 * Comparison runs through {@link brandConfigIdToDisplayName} so stored variants
 * ("BALL WATCH" vs "BALL") are removed together. Other tokens keep their stored form.
 * Returns null when nothing remains.
 */
export function removeBrandFromCsvField(
  raw: string | null | undefined,
  brand: string
): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const target = brandConfigIdToDisplayName(brand).toLowerCase();
  if (!target) return String(raw).trim() || null;
  const kept = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => brandConfigIdToDisplayName(t).toLowerCase() !== target);
  return kept.length ? kept.join(', ') : null;
}

/**
 * Remove specific brands from a Custom Brands field. The field stores either anchor HTML
 * ("<a href=…>MARATHON</a>, <a …>ROLEX</a>") or plain comma-separated names; entries are
 * matched through {@link brandConfigIdToDisplayName} so spelling variants are removed
 * together. Returns null when nothing remains.
 */
export function removeBrandsFromCustomBrandsField(
  raw: string | null | undefined,
  removedBrands: string[]
): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const removed = new Set(
    removedBrands.map((b) => brandConfigIdToDisplayName(b).toLowerCase()).filter(Boolean)
  );
  if (removed.size === 0) return s;

  const anchors = s.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi);
  if (anchors && anchors.length > 0) {
    const kept = anchors.filter((a) => {
      const text = a.replace(/<[^>]+>/g, '').trim();
      return !removed.has(brandConfigIdToDisplayName(text).toLowerCase());
    });
    return kept.length ? kept.join(', ') : null;
  }

  const kept = s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !removed.has(brandConfigIdToDisplayName(t).toLowerCase()));
  return kept.length ? kept.join(', ') : null;
}

/**
 * Tags: only rewrite tokens that look like brand_* config ids; leave other tags as-is.
 */
export function normalizeTagsCsvField(raw: string | null | undefined): string | null {
  if (raw == null || !String(raw).trim()) return null;
  const tokens = String(raw)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out = tokens.map((t) => (looksLikeBrandConfigId(t) ? brandConfigIdToDisplayName(t) : t));
  return out.join(', ') || null;
}
