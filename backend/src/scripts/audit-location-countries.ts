/**
 * List distinct Location.country values and flag strings that are not ISO-recognizable
 * countries/territories after normalizeCountry (e.g. cities in the wrong column).
 *
 *   npm run audit:location-countries
 */

import 'dotenv/config';
import prisma from '../lib/prisma';
import { normalizeCountry, isRecognizedCountryOrTerritory } from '../utils/country';

async function main() {
  const groups = await prisma.location.groupBy({
    by: ['country'],
    _count: { _all: true },
    orderBy: { country: 'asc' },
  });

  console.log(`Distinct country strings: ${groups.length}\n`);

  const suspicious: { raw: string; normalized: string; rows: number }[] = [];
  const needsNormalize: { raw: string; normalized: string; rows: number }[] = [];

  for (const g of groups) {
    const raw = g.country ?? '';
    const normalized = normalizeCountry(raw);
    const ok = isRecognizedCountryOrTerritory(raw);
    const count = g._count._all;

    if (!ok) {
      suspicious.push({ raw, normalized, rows: count });
    } else if (normalized !== raw) {
      needsNormalize.push({ raw, normalized, rows: count });
    }
  }

  console.log('=== Recognized; stored text already canonical ===');
  for (const g of groups) {
    const raw = g.country ?? '';
    const normalized = normalizeCountry(raw);
    if (!isRecognizedCountryOrTerritory(raw)) continue;
    if (normalized === raw) {
      console.log(`  ${raw.padEnd(42)}  rows=${g._count._all}`);
    }
  }

  console.log('\n=== Recognized but normalizeCountry would change spelling/variant ===');
  if (needsNormalize.length === 0) {
    console.log('  (none)');
  } else {
    for (const x of needsNormalize) {
      console.log(`  rows=${x.rows}\n    stored: "${x.raw}"\n    canonical: "${x.normalized}"`);
    }
  }

  const emptyCountry = suspicious.filter((x) => x.raw.trim() === '');
  const dataSuspicious = suspicious.filter((x) => x.raw.trim() !== '');

  console.log('\n=== Empty country (fix required — not a valid country label) ===');
  if (emptyCountry.length === 0) {
    console.log('  (none)');
  } else {
    for (const x of emptyCountry) {
      console.log(`  rows=${x.rows} (blank string)`);
    }
  }

  console.log('\n=== Not a known country/territory (review — may be city, typo, or obsolete region name) ===');
  if (dataSuspicious.length === 0) {
    console.log('  (none)');
  } else {
    for (const x of dataSuspicious) {
      console.log(`  rows=${x.rows}\n    stored: "${x.raw}"\n    normalized: "${x.normalized}"`);
    }
  }

  const totalBadRows = dataSuspicious.reduce((a, x) => a + x.rows, 0);
  console.log('\n' + '='.repeat(60));
  console.log(
    `Summary: ${groups.length} distinct values | ${emptyCountry.reduce((a, x) => a + x.rows, 0)} row(s) blank country | ${dataSuspicious.length} non-ISO label(s) (${totalBadRows} rows)`
  );

  await prisma.$disconnect();
  process.exit(dataSuspicious.length > 0 ? 2 : 0);
}

main().catch((e) => {
  console.error(e);
  prisma.$disconnect().finally(() => process.exit(1));
});
