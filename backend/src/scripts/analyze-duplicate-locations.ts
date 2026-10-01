/**
 * Report likely duplicate Location rows (same name, coords, address key) and
 * similar addresses (normalized fingerprint, substring overlap, optional pg_trgm).
 *
 * Use --json-out <file> or --csv-out <file> to emit a machine-readable candidate-pairs
 * report suitable for spreadsheet review or a future admin UI.  Each pair includes
 * signal flags (tripletWouldMerge, sameRoundedCoords, sameAddressFp, etc.) computed
 * with the same helpers used by the live import and merge-CLI paths.
 *
 * Usage:
 *   npm run analyze-duplicates
 *   npx ts-node src/scripts/analyze-duplicate-locations.ts
 *   npx ts-node src/scripts/analyze-duplicate-locations.ts --json-out /tmp/dupes.json
 *   npx ts-node src/scripts/analyze-duplicate-locations.ts --csv-out /tmp/dupes.csv
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { dedupeAddressFingerprint } from '../utils/address-dedupe';
import { normalizeCountry } from '../utils/country';
import {
  haversineDistanceMeters,
  isUnusableScraperCoordinate,
  namesSimilarForDedupe,
  normalizeNameForDedupe,
} from '../utils/geo-dedupe';
import {
  addressesShareStreetNumber,
  buildDedupPlans,
  fingerprintGroupKey,
  GEO_PROXIMITY_M,
  type MergeStoreRow,
} from '../utils/location-merge-core';

// ─── CLI flags ────────────────────────────────────────────────────────────────

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : null;
}

const jsonOutPath = argValue('--json-out');
const csvOutPath = argValue('--csv-out');

// ─── Candidate pair type ──────────────────────────────────────────────────────

/** A flagged pair of likely-duplicate rows for human triage. */
type CandidatePair = {
  handleA: string;
  handleB: string;
  nameA: string;
  nameB: string;
  addressA: string;
  addressB: string;
  cityA: string;
  cityB: string;
  countryA: string;
  countryB: string;
  latA: number;
  lonA: number;
  latB: number;
  lonB: number;
  distanceMeters: number | null;
  fpA: string;
  fpB: string;
  signal: string;
  // Pre-computed boolean flags for filtering
  sameRoundedCoords: boolean;
  sameAddressFp: boolean;
  sameNormName: boolean;
  namesSimilar: boolean;
  addressSharesStreetNumber: boolean;
  tripletWouldMerge: boolean;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundedCoordsKey(r: { latitude: number; longitude: number }): string {
  return `${r.latitude.toFixed(5)}|${r.longitude.toFixed(5)}`;
}

function computeDistance(a: MergeStoreRow, b: MergeStoreRow): number | null {
  if (
    isUnusableScraperCoordinate(a.latitude, a.longitude) ||
    isUnusableScraperCoordinate(b.latitude, b.longitude)
  )
    return null;
  return haversineDistanceMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}

function makePair(a: MergeStoreRow, b: MergeStoreRow, signal: string): CandidatePair {
  const dist = computeDistance(a, b);
  const fpA = dedupeAddressFingerprint(a.addressLine1);
  const fpB = dedupeAddressFingerprint(b.addressLine1);
  const sameRoundedCoords = roundedCoordsKey(a) === roundedCoordsKey(b);
  const sameAddressFp =
    fpA.length >= 6 && fpB.length >= 6 && fingerprintGroupKey(a) === fingerprintGroupKey(b);
  const sameNormName = normalizeNameForDedupe(a.name) === normalizeNameForDedupe(b.name);
  const similar = namesSimilarForDedupe(a.name, b.name);
  const sharesStreetNo = addressesShareStreetNumber(a.addressLine1, b.addressLine1);
  const tripletWouldMerge =
    sameRoundedCoords &&
    (sameNormName || similar) &&
    (sameAddressFp || sharesStreetNo) &&
    dist !== null &&
    dist <= GEO_PROXIMITY_M;

  return {
    handleA: a.handle,
    handleB: b.handle,
    nameA: a.name,
    nameB: b.name,
    addressA: a.addressLine1,
    addressB: b.addressLine1,
    cityA: a.city,
    cityB: b.city,
    countryA: a.country,
    countryB: b.country,
    latA: a.latitude,
    lonA: a.longitude,
    latB: b.latitude,
    lonB: b.longitude,
    distanceMeters: dist !== null ? Math.round(dist) : null,
    fpA,
    fpB,
    signal,
    sameRoundedCoords,
    sameAddressFp,
    sameNormName,
    namesSimilar: similar,
    addressSharesStreetNumber: sharesStreetNo,
    tripletWouldMerge,
  };
}

// ─── Export writers ───────────────────────────────────────────────────────────

function writeJson(pairs: CandidatePair[], filePath: string): void {
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, JSON.stringify(pairs, null, 2), 'utf8');
  console.log(`\nJSON candidate pairs written to ${resolved} (${pairs.length} pairs)`);
}

function writeCsv(pairs: CandidatePair[], filePath: string): void {
  const headers: (keyof CandidatePair)[] = [
    'handleA', 'handleB', 'nameA', 'nameB', 'addressA', 'addressB',
    'cityA', 'cityB', 'countryA', 'countryB',
    'latA', 'lonA', 'latB', 'lonB', 'distanceMeters',
    'fpA', 'fpB', 'signal',
    'sameRoundedCoords', 'sameAddressFp', 'sameNormName',
    'namesSimilar', 'addressSharesStreetNumber', 'tripletWouldMerge',
  ];
  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.join(','),
    ...pairs.map((p) => headers.map((h) => escape(p[h])).join(',')),
  ];
  const resolved = path.resolve(filePath);
  fs.writeFileSync(resolved, lines.join('\n'), 'utf8');
  console.log(`\nCSV candidate pairs written to ${resolved} (${pairs.length} pairs)`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Duplicate / near-duplicate analysis (Location) ===\n');

  const total = await prisma.location.count();
  console.log(`Total locations: ${total}\n`);

  const dupNameExact = await prisma.$queryRaw<
    { name: string; cnt: bigint; handles: string[] }[]
  >`
    SELECT "name", COUNT(*)::bigint AS cnt, array_agg("handle" ORDER BY "handle") AS handles
    FROM "Location"
    GROUP BY "name"
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 40
  `;
  console.log(`--- Same exact Name (case-sensitive), count > 1: ${dupNameExact.length} groups ---`);
  for (const row of dupNameExact.slice(0, 15)) {
    console.log(`  ${Number(row.cnt)}× "${row.name}" → ${row.handles.slice(0, 5).join(', ')}${row.handles.length > 5 ? '…' : ''}`);
  }
  if (dupNameExact.length > 15) console.log(`  … and ${dupNameExact.length - 15} more groups\n`);
  else console.log('');

  const dupNameNorm = await prisma.$queryRaw<
    { norm_name: string; cnt: bigint; handles: string[] }[]
  >`
    SELECT LOWER(TRIM("name")) AS norm_name, COUNT(*)::bigint AS cnt,
           array_agg("handle" ORDER BY "handle") AS handles
    FROM "Location"
    GROUP BY LOWER(TRIM("name"))
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 40
  `;
  console.log(`--- Same Name (case-insensitive trim), count > 1: ${dupNameNorm.length} groups ---`);
  for (const row of dupNameNorm.slice(0, 15)) {
    console.log(`  ${Number(row.cnt)}× "${row.norm_name}" → ${row.handles.slice(0, 4).join(', ')}${row.handles.length > 4 ? '…' : ''}`);
  }
  console.log('');

  const dupCoords = await prisma.$queryRaw<
    { lat: string; lng: string; cnt: bigint; handles: string[] }[]
  >`
    SELECT ROUND("latitude"::numeric, 5)::text AS lat,
           ROUND("longitude"::numeric, 5)::text AS lng,
           COUNT(*)::bigint AS cnt,
           array_agg("handle" ORDER BY "handle") AS handles
    FROM "Location"
    GROUP BY ROUND("latitude"::numeric, 5), ROUND("longitude"::numeric, 5)
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 40
  `;
  console.log(`--- Same coordinates (5 dp), count > 1: ${dupCoords.length} groups ---`);
  for (const row of dupCoords.slice(0, 15)) {
    console.log(`  ${Number(row.cnt)}× (${row.lat}, ${row.lng}) → ${row.handles.slice(0, 4).join(', ')}${row.handles.length > 4 ? '…' : ''}`);
  }
  console.log('');

  const dupAddrKey = await prisma.$queryRaw<
    { addr_key: string; cnt: bigint; handles: string[] }[]
  >`
    SELECT
      LOWER(TRIM(COALESCE("addressLine1", ''))) || '|' ||
      LOWER(TRIM(COALESCE("city", ''))) || '|' ||
      LOWER(TRIM(COALESCE("country", ''))) AS addr_key,
      COUNT(*)::bigint AS cnt,
      array_agg("handle" ORDER BY "handle") AS handles
    FROM "Location"
    WHERE LENGTH(TRIM(COALESCE("addressLine1", ''))) > 3
    GROUP BY 1
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 40
  `;
  console.log(`--- Same addressLine1 + city + country (normalized), count > 1: ${dupAddrKey.length} groups ---`);
  for (const row of dupAddrKey.slice(0, 12)) {
    console.log(`  ${Number(row.cnt)}× ${row.addr_key.slice(0, 80)}${row.addr_key.length > 80 ? '…' : ''}`);
    console.log(`      handles: ${row.handles.slice(0, 4).join(', ')}${row.handles.length > 4 ? '…' : ''}`);
  }
  console.log('');

  const dupAddrFingerprint = await prisma.$queryRaw<
    { fp: string; city_norm: string; country_norm: string; cnt: bigint; handles: string[]; samples: string[] }[]
  >`
    WITH x AS (
      SELECT
        "handle",
        regexp_replace(
          lower(trim(COALESCE("addressLine1", ''))),
          '[^a-z0-9]',
          '',
          'g'
        ) AS addr_fp,
        lower(trim(COALESCE("city", ''))) AS city_norm,
        lower(trim(COALESCE("country", ''))) AS country_norm,
        TRIM(COALESCE("addressLine1", '')) AS addr_raw
      FROM "Location"
      WHERE LENGTH(regexp_replace(lower(trim(COALESCE("addressLine1", ''))), '[^a-z0-9]', '', 'g')) >= 6
    )
    SELECT
      addr_fp AS fp,
      city_norm,
      country_norm,
      COUNT(*)::bigint AS cnt,
      array_agg("handle" ORDER BY "handle") AS handles,
      array_agg(DISTINCT LEFT(addr_raw, 60) ORDER BY LEFT(addr_raw, 60)) AS samples
    FROM x
    GROUP BY addr_fp, city_norm, country_norm
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 50
  `;
  console.log(
    `--- Same address fingerprint (letters+digits only in line1) + city + country: ${dupAddrFingerprint.length} groups ---`
  );
  for (const row of dupAddrFingerprint.slice(0, 15)) {
    console.log(
      `  ${Number(row.cnt)}× fp="${row.fp.slice(0, 48)}${row.fp.length > 48 ? '…' : ''}" | ${row.city_norm}, ${row.country_norm}`
    );
    const show = (row.samples as string[]).slice(0, 3);
    for (const s of show) console.log(`      "${s}"`);
    console.log(`      handles: ${row.handles.slice(0, 4).join(', ')}${row.handles.length > 4 ? '…' : ''}`);
  }
  if (dupAddrFingerprint.length > 15) console.log(`  … and ${dupAddrFingerprint.length - 15} more groups\n`);
  else console.log('');

  const similarAddrPairs = await prisma.$queryRaw<
    {
      handle_a: string;
      handle_b: string;
      addr_a: string;
      addr_b: string;
      city: string;
      country: string;
    }[]
  >`
    WITH x AS (
      SELECT
        "handle",
        regexp_replace(
          lower(trim(COALESCE("addressLine1", ''))),
          '[^a-z0-9]',
          '',
          'g'
        ) AS addr_fp,
        lower(trim(COALESCE("city", ''))) AS city_norm,
        lower(trim(COALESCE("country", ''))) AS country_norm,
        TRIM(COALESCE("addressLine1", '')) AS addr_raw
      FROM "Location"
      WHERE LENGTH(regexp_replace(lower(trim(COALESCE("addressLine1", ''))), '[^a-z0-9]', '', 'g')) >= 10
    )
    SELECT
      a."handle" AS handle_a,
      b."handle" AS handle_b,
      a.addr_raw AS addr_a,
      b.addr_raw AS addr_b,
      a.city_norm AS city,
      a.country_norm AS country
    FROM x a
    JOIN x b
      ON a."handle" < b."handle"
      AND a.country_norm = b.country_norm
      AND a.city_norm = b.city_norm
      AND a.addr_fp <> b.addr_fp
      AND (
        a.addr_fp LIKE '%' || b.addr_fp || '%'
        OR b.addr_fp LIKE '%' || a.addr_fp || '%'
      )
    ORDER BY LENGTH(a.addr_fp) + LENGTH(b.addr_fp) ASC
    LIMIT 80
  `;
  console.log(
    `--- Similar addresses (same city+country; one normalized line1 contains the other): ${similarAddrPairs.length} pairs ---`
  );
  for (const p of similarAddrPairs.slice(0, 20)) {
    console.log(`  ${p.handle_a}  |  ${p.handle_b}`);
    console.log(`    A: ${p.addr_a.slice(0, 90)}${p.addr_a.length > 90 ? '…' : ''}`);
    console.log(`    B: ${p.addr_b.slice(0, 90)}${p.addr_b.length > 90 ? '…' : ''}`);
  }
  if (similarAddrPairs.length > 20) console.log(`  … and ${similarAddrPairs.length - 20} more pairs\n`);
  else console.log('');

  try {
    const trgmPairs = await prisma.$queryRaw<
      { handle_a: string; handle_b: string; addr_a: string; addr_b: string; sim: number }[]
    >`
      WITH x AS (
        SELECT
          "handle",
          regexp_replace(lower(trim(COALESCE("addressLine1", ''))), '[^a-z0-9]', '', 'g') AS addr_fp,
          lower(trim(COALESCE("city", ''))) AS city_norm,
          lower(trim(COALESCE("country", ''))) AS country_norm,
          TRIM(COALESCE("addressLine1", '')) AS addr_raw
        FROM "Location"
        WHERE LENGTH(regexp_replace(lower(trim(COALESCE("addressLine1", ''))), '[^a-z0-9]', '', 'g')) >= 12
      )
      SELECT
        a."handle" AS handle_a,
        b."handle" AS handle_b,
        a.addr_raw AS addr_a,
        b.addr_raw AS addr_b,
        similarity(a.addr_fp, b.addr_fp)::float AS sim
      FROM x a
      JOIN x b
        ON a."handle" < b."handle"
        AND a.country_norm = b.country_norm
        AND a.city_norm = b.city_norm
        AND a.addr_fp <> b.addr_fp
      WHERE similarity(a.addr_fp, b.addr_fp) > 0.45
      ORDER BY sim DESC
      LIMIT 40
    `;
    console.log(
      `--- pg_trgm similarity (same city+country, sim > 0.45): ${trgmPairs.length} pairs ---`
    );
    for (const p of trgmPairs.slice(0, 15)) {
      console.log(`  sim=${p.sim.toFixed(3)}  ${p.handle_a} | ${p.handle_b}`);
      console.log(`    A: ${p.addr_a.slice(0, 70)}${p.addr_a.length > 70 ? '…' : ''}`);
      console.log(`    B: ${p.addr_b.slice(0, 70)}${p.addr_b.length > 70 ? '…' : ''}`);
    }
    if (trgmPairs.length > 15) console.log(`  … and ${trgmPairs.length - 15} more pairs\n`);
    else console.log('');
  } catch {
    console.log(
      '(Skipped fuzzy trgm block: run `CREATE EXTENSION IF NOT EXISTS pg_trgm;` on the DB for similarity-based pairs.)\n'
    );
  }

  const nearDup = await prisma.$queryRaw<
    { name_a: string; handle_a: string; name_b: string; handle_b: string; dist_m: number }[]
  >`
    WITH pairs AS (
      SELECT
        a."name" AS name_a, a."handle" AS handle_a,
        b."name" AS name_b, b."handle" AS handle_b,
        (
          6371000 * acos(
            LEAST(1.0, GREATEST(-1.0,
              cos(radians(a."latitude")) * cos(radians(b."latitude"))
              * cos(radians(b."longitude") - radians(a."longitude"))
              + sin(radians(a."latitude")) * sin(radians(b."latitude"))
            ))
          )
        )::float AS dist_m
      FROM "Location" a
      JOIN "Location" b ON a."handle" < b."handle"
      WHERE LOWER(TRIM(a."name")) = LOWER(TRIM(b."name"))
        AND a."country" = b."country"
    )
    SELECT name_a, handle_a, name_b, handle_b, dist_m
    FROM pairs
    WHERE dist_m > 5 AND dist_m < 500
    ORDER BY dist_m ASC
    LIMIT 25
  `;
  console.log(`--- Same normalized name + country, different handles, 5m < distance < 500m (sample) ---`);
  console.log(`    (${nearDup.length} pairs — possible duplicate handles with coordinate drift)\n`);
  for (const p of nearDup.slice(0, 15)) {
    console.log(`  ~${Math.round(p.dist_m)}m  ${p.handle_a} vs ${p.handle_b}`);
    console.log(`         "${p.name_a}"`);
  }

  console.log('\nDone.');

  // ─── Optional candidate-pair export ─────────────────────────────────────────
  if (!jsonOutPath && !csvOutPath) return;

  console.log('\nBuilding candidate-pair export (loading all locations)…');

  const allRaw = await prisma.location.findMany({
    select: {
      handle: true,
      name: true,
      brands: true,
      customBrands: true,
      tags: true,
      addressLine1: true,
      city: true,
      country: true,
      latitude: true,
      longitude: true,
      isPremium: true,
      updatedAt: true,
    },
    orderBy: { handle: 'asc' },
  });
  const all = allRaw as MergeStoreRow[];

  const candidatePairs: CandidatePair[] = [];
  const seen = new Set<string>();

  const addPair = (a: MergeStoreRow, b: MergeStoreRow, signal: string) => {
    const key = [a.handle, b.handle].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidatePairs.push(makePair(a, b, signal));
  };

  // Emit pairs from the buildDedupPlans merge groups (these are the auto-mergeable ones)
  const plans = buildDedupPlans(all);
  const byHandle = new Map(all.map((r) => [r.handle, r]));
  for (const plan of plans) {
    for (const loser of plan.remove) {
      addPair(plan.keep, loser, `auto-merge:${plan.label}`);
    }
  }

  // Also emit pairs that share rounded coordinates but are NOT auto-merged (different names/addresses)
  const byCoordCountry = new Map<string, MergeStoreRow[]>();
  for (const r of all) {
    if (isUnusableScraperCoordinate(r.latitude, r.longitude)) continue;
    const k = `${r.latitude.toFixed(5)}|${r.longitude.toFixed(5)}|${normalizeCountry(r.country)}`;
    const list = byCoordCountry.get(k) ?? [];
    list.push(r);
    byCoordCountry.set(k, list);
  }
  for (const group of byCoordCountry.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addPair(group[i]!, group[j]!, 'same-coords:review');
      }
    }
  }

  // And pairs from address-fingerprint groups that are NOT auto-merged (coord spread too wide, etc.)
  const fpIndex = new Map<string, MergeStoreRow[]>();
  for (const r of all) {
    const fp = dedupeAddressFingerprint(r.addressLine1);
    if (fp.length < 6) continue;
    const k = fingerprintGroupKey(r);
    const list = fpIndex.get(k) ?? [];
    list.push(r);
    fpIndex.set(k, list);
  }
  for (const group of fpIndex.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        addPair(group[i]!, group[j]!, 'same-addr-fp:review');
      }
    }
  }

  // Sort: auto-merge candidates first, then by ascending distance
  candidatePairs.sort((a, b) => {
    const aAuto = a.signal.startsWith('auto-merge') ? 0 : 1;
    const bAuto = b.signal.startsWith('auto-merge') ? 0 : 1;
    if (aAuto !== bAuto) return aAuto - bAuto;
    return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
  });

  if (jsonOutPath) writeJson(candidatePairs, jsonOutPath);
  if (csvOutPath) writeCsv(candidatePairs, csvOutPath);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
