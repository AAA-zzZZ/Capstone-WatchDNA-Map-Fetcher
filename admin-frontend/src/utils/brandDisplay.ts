/** Match backend `brand-display-name.ts` for Premium Stores filter + pills. */

const SUFFIXES = ['_stores', '_retailers', '_dealers', '_watches'] as const;

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

function stripSimpleHtml(s: string): string {
  let t = s.replace(/<[^>]+>/g, '');
  t = t.replace(/<[^>]*$/gi, '');
  return t;
}

function stripLeadingMarkupJunk(s: string): string {
  return s
    .replace(/^["']+\s*>\s*/g, '')
    .replace(/^>\s*/g, '')
    .trim();
}

function looksLikeHtmlOrUrlGarbage(upper: string): boolean {
  if (!upper) return true;
  if (/\bHREF\s*=/.test(upper)) return true;
  if (/HTTPS?:\/\//.test(upper)) return true;
  if (/[<>]/.test(upper)) return true;
  return false;
}

function looksLikeAddressLine(upper: string): boolean {
  if (!/^\d{1,5}\s+/.test(upper)) return false;
  return /\b(RUE|RUA|VIA|VIALE|CORSO|PIAZZA|C\/|STREET|ST\.|AVENUE|ROAD|BLVD|BOULEVARD|LANE|DRIVE|WAY|COURT|CARRER)\b/i.test(upper);
}

/** Keep in sync with backend `brandConfigIdToDisplayName` in brand-display-name.ts */
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
  if (!/[A-Z0-9]/i.test(name)) return '';
  if (looksLikeAddressLine(name)) return '';
  if (looksLikeHtmlOrUrlGarbage(name)) return '';
  return DISPLAY_OVERRIDES[name] ?? name;
}

/** Brands column: every token → display name (ALL CAPS, no _stores). */
export function parseBrandsForDisplay(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
    const d = brandConfigIdToDisplayName(t);
    if (!d) continue;
    const k = d.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
  }
  return out;
}

export function storeMatchesBrandFilter(
  rawBrands: string | null | undefined,
  selectedDisplay: string
): boolean {
  if (!selectedDisplay) return true;
  return parseBrandsForDisplay(rawBrands).includes(selectedDisplay);
}
