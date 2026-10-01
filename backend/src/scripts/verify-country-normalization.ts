/**
 * Verify country normalization.
 *
 * Backup comparison (pre vs post JSON from normalize-db-countries):
 *   npx ts-node src/scripts/verify-country-normalization.ts [pre.json] [post.json]
 *   npm run verify-countries
 *
 * Live database (Prisma / DATABASE_URL):
 *   npm run verify-countries -- --db
 *   (There is no separate verify-countries-db script; pass --db as above.)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { normalizeCountry } from '../utils/country';

interface Row {
  id: string;
  handle: string;
  name: string;
  country: string;
}

interface Backup {
  locations: Row[];
}

function load(p: string): Backup {
  const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
  return JSON.parse(fs.readFileSync(abs, 'utf-8')) as Backup;
}

/** Idempotency + no bare ISO alpha-2 in stored country. */
function verifyCanonicalState(locations: Row[], label: string) {
  let notIdempotent = 0;
  const idemSamples: string[] = [];
  for (const r of locations) {
    const n = normalizeCountry(r.country);
    if (n !== r.country) {
      notIdempotent++;
      if (idemSamples.length < 15) {
        idemSamples.push(
          `  handle=${r.handle}  stored="${r.country}"  → would become "${n}"`
        );
      }
    }
  }

  const alpha2 = /^[A-Za-z]{2}$/;
  const stillCodes: Row[] = [];
  for (const r of locations) {
    if (alpha2.test(r.country.trim())) stillCodes.push(r);
  }

  console.log(`${label}`);
  console.log('-'.repeat(60));
  console.log(
    `  Idempotent (normalizeCountry(x)===x): ${notIdempotent === 0 ? 'OK' : 'FAIL'} (${notIdempotent} row(s))`
  );
  if (idemSamples.length) {
    console.log('  Samples:');
    idemSamples.forEach((s) => console.log(s));
  }
  console.log(
    `  No 2-letter country field: ${stillCodes.length === 0 ? 'OK' : 'WARN'} (${stillCodes.length} row(s))`
  );
  if (stillCodes.length) {
    const uniq = [...new Set(stillCodes.map((r) => r.country))].sort();
    console.log(`  Distinct 2-letter values: ${uniq.join(', ')}`);
    stillCodes.slice(0, 10).forEach((r) => {
      console.log(`    e.g. handle=${r.handle}  "${r.country}"`);
    });
  }

  const distinct = new Set(locations.map((r) => r.country)).size;
  console.log(`  Distinct country strings: ${distinct}`);
  console.log('');

  return { ok: notIdempotent === 0, notIdempotent, stillCodes };
}

async function verifyDatabase() {
  console.log('Country normalization verification (live database)');
  console.log('='.repeat(60));
  console.log('Source: Prisma Location.country via DATABASE_URL\n');

  const rows = await prisma.location.findMany({
    select: { id: true, handle: true, name: true, country: true },
    orderBy: { handle: 'asc' },
  });

  console.log(`Loaded ${rows.length} location(s).\n`);

  const { ok, notIdempotent, stillCodes } = verifyCanonicalState(rows, 'Checks');

  console.log('='.repeat(60));
  if (ok && stillCodes.length === 0) {
    console.log('OVERALL: DB country column matches canonical rules.');
  } else {
    console.log('OVERALL: See issues above. Re-run npm run normalize-countries or fix data.');
  }

  await prisma.$disconnect();
  process.exit(ok && stillCodes.length === 0 ? 0 : 1);
}

function verifyBackupPair(prePath: string, postPath: string) {
  const pre = load(prePath);
  const post = load(postPath);
  const preById = new Map(pre.locations.map((r) => [r.id, r]));
  const postById = new Map(post.locations.map((r) => [r.id, r]));

  console.log('Country normalization verification (backup files)');
  console.log('='.repeat(60));
  console.log(`Pre:  ${prePath} (${pre.locations.length} rows)`);
  console.log(`Post: ${postPath} (${post.locations.length} rows)\n`);

  const preIds = new Set(pre.locations.map((r) => r.id));
  const postIds = new Set(post.locations.map((r) => r.id));
  let idMismatch = 0;
  for (const id of preIds) {
    if (!postIds.has(id)) idMismatch++;
  }
  for (const id of postIds) {
    if (!preIds.has(id)) idMismatch++;
  }
  console.log(`1. Row id parity: ${idMismatch === 0 ? 'OK' : 'FAIL'} (missing/extra: ${idMismatch})`);

  let forwardMismatch = 0;
  const forwardSamples: string[] = [];
  for (const p of pre.locations) {
    const after = postById.get(p.id);
    if (!after) continue;
    const expected = normalizeCountry(p.country);
    if (after.country !== expected) {
      forwardMismatch++;
      if (forwardSamples.length < 15) {
        forwardSamples.push(
          `  id=${p.id.slice(0, 8)}… handle=${p.handle}\n` +
            `    pre="${p.country}" → normalizeCountry="${expected}" but post="${after.country}"`
        );
      }
    }
  }
  console.log(
    `2. post.country === normalizeCountry(pre.country): ${forwardMismatch === 0 ? 'OK' : 'FAIL'} (${forwardMismatch} mismatches)`
  );
  if (forwardSamples.length) {
    console.log('   Samples:');
    forwardSamples.forEach((s) => console.log(s));
  }

  const canonical = verifyCanonicalState(post.locations, '3–4. Post snapshot');
  const notIdempotent = canonical.notIdempotent;
  const stillCodes = canonical.stillCodes;

  let changed = 0;
  const changePatterns = new Map<string, number>();
  for (const p of pre.locations) {
    const a = postById.get(p.id);
    if (!a) continue;
    if (p.country !== a.country) {
      changed++;
      const key = `"${p.country}" → "${a.country}"`;
      changePatterns.set(key, (changePatterns.get(key) || 0) + 1);
    }
  }
  console.log(`5. Rows with country text changed: ${changed}`);
  const top = [...changePatterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('   Top transformation patterns:');
  top.forEach(([k, n]) => console.log(`   ${n}\t${k}`));

  const ok = idMismatch === 0 && forwardMismatch === 0 && notIdempotent === 0;
  console.log('\n' + '='.repeat(60));
  console.log(ok ? 'OVERALL: All structural checks passed.' : 'OVERALL: See failures above.');
  if (stillCodes.length) {
    console.log('Note: 2-letter leftovers may be invalid codes or intentional passthrough.');
  }
  process.exit(ok ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const useDb = args.includes('--db');
  const fileArgs = args.filter((a) => a !== '--db');

  if (useDb) {
    verifyDatabase().catch((err) => {
      console.error('❌', err);
      prisma.$disconnect().finally(() => process.exit(1));
    });
    return;
  }

  const backupsDir = path.join(process.cwd(), 'backups');
  const defaults = [
    path.join(backupsDir, 'location-countries-2026-03-24T20-57-31-546Z.json'),
    path.join(backupsDir, 'location-countries-2026-03-24T20-57-51-729Z.json'),
  ];
  const prePath = fileArgs[0] || defaults[0];
  const postPath = fileArgs[1] || defaults[1];

  if (!fs.existsSync(prePath) || !fs.existsSync(postPath)) {
    console.error(
      'Usage:\n' +
        '  npm run verify-countries -- --db\n' +
        '  npm run verify-countries -- <pre.json> <post.json>'
    );
    process.exit(1);
  }

  verifyBackupPair(prePath, postPath);
}

main();
