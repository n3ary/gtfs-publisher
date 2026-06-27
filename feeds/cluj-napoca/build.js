#!/usr/bin/env node

/**
 * feeds/cluj-napoca/build.js — the only custom build script in neary-gtfs.
 *
 * Pipeline:
 *   1. Receive a seed GTFS .zip from src/pipeline/fetch-gtfs.js via
 *      NEARY_SEED_ZIP (the Transitous-resolved Cluj-Napoca mirror).
 *   2. Scrape ctpcj.ro CSV timetables for every route × {LV,S,D}.
 *   3. REPLACE calendar.txt + trips.txt + stop_times.txt with our fresh
 *      schedule. KEEP agency/routes/stops/shapes.txt from the seed.
 *   4. Add feed_info.txt with neary-gtfs metadata.
 *   5. Re-pack the zip → $NEARY_OUTPUT_ZIP (outputs/feeds/cluj-napoca.gtfs.zip).
 *
 * Output trip_ids match the canonical CTP format used by the
 * cluj-rt-feed.gtfs.ro GTFS-Realtime endpoints exactly:
 *   `<route_id>_<direction>_<serviceId>_<seq>_<HHMM>`  e.g. 45_1_LV_9_0721
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeed } from './lib/seed.js';
import { computeStopTimes } from './lib/timing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const FEED_DIR = __dirname;
const OUTPUTS = join(REPO_ROOT, 'outputs', 'feeds');

const config = JSON.parse(readFileSync(join(FEED_DIR, 'config.json'), 'utf8'));
const buildCfg = config.build;

const LOG = (msg) => console.log(`[cluj-napoca] ${msg}`);

// The pipeline (fetch-gtfs.js) downloads the Transitous-resolved
// Cluj-Napoca zip and passes its path here via NEARY_SEED_ZIP. When
// running the build standalone for local testing, fall back to
// downloading Transitous directly.
const seedSource =
  process.env.NEARY_SEED_ZIP ?? 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

LOG(`Building CTP Cluj GTFS — seed: ${seedSource}`);

// ──────────────────────────────────────────────────────────────────────────
// Step 1: seed
// ──────────────────────────────────────────────────────────────────────────

const seed = await loadSeed(seedSource);

// stop_id → {lat, lon} for distance interpolation
const stopCoords = new Map(seed.stops.map((s) => [s.stopId, { lat: s.lat, lon: s.lon }]));

// (route_id, direction_id) → representative trip's stop sequence
const patternByRouteDir = new Map();
for (const trip of seed.trips) {
  const key = `${trip.routeId}|${trip.directionId}`;
  if (patternByRouteDir.has(key)) continue;
  const stops = seed.stopTimes.get(trip.tripId);
  if (!stops || stops.length === 0) continue;
  patternByRouteDir.set(key, { stops, shapeId: trip.shapeId, headsign: trip.headsign });
}
LOG(`patterns: ${patternByRouteDir.size}`);
LOG(`shapes: ${seed.shapesById.size}`);

// ──────────────────────────────────────────────────────────────────────────
// Step 2: CSV scrape
// ──────────────────────────────────────────────────────────────────────────

const SERVICE_KEYS = buildCfg.serviceKeys;
const SERVICE_MAP = buildCfg.serviceIdMap;

async function fetchCsv(routeShortName, serviceKey) {
  const url = buildCfg.csvUrlPattern
    .replace('{routeShortName}', routeShortName)
    .replace('{serviceId}', serviceKey);
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        // ctpcj.ro's WAF treats Node's undici defaults as suspicious.
        // Mimicking a real browser bypasses both the 415 and the silent
        // challenge-page-with-200 fallback. Tested headers as of 2026-06.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://ctpcj.ro/index.php/ro/orare-linii/linii-urbane',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
      },
    });
    if (!res.ok) {
      if (res.status !== 404) LOG(`  ⚠ ${routeShortName}_${serviceKey}: HTTP ${res.status}`);
      return null;
    }
    const body = await res.text();
    // Sanity check: real CSV always starts with "route_long_name,". Anything
    // else (WAF challenge page, captcha HTML, etc.) is a soft failure.
    if (!body.startsWith('route_long_name,')) {
      LOG(`  ⚠ ${routeShortName}_${serviceKey}: not CSV (got ${body.length}B starting "${body.slice(0, 40).replace(/\s+/g, ' ')}…")`);
      return null;
    }
    return body;
  } catch (err) {
    LOG(`  ⚠ ${routeShortName}_${serviceKey}: ${err.message || err}`);
    return null;
  }
}

function parseCtpCsv(csvText) {
  const lines = csvText.trim().split('\n').map((l) => l.trim()).filter((l) => l);
  if (lines.length < 6) return null;
  const routeLongName = lines[0].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceName = lines[1].split(',').slice(1).join(',').replace(/"/g, '');
  const serviceStart = lines[2].split(',').slice(1).join(',').replace(/"/g, '');
  const inStopName = lines[3].split(',').slice(1).join(',').replace(/"/g, '');
  const outStopName = lines[4].split(',').slice(1).join(',').replace(/"/g, '');
  const departures = { dir0: [], dir1: [] };
  for (let i = 5; i < lines.length; i++) {
    const parts = lines[i].split(',').map((p) => p.trim());
    if (parts[0] && /^\d{1,2}:\d{2}$/.test(parts[0])) departures.dir0.push(parts[0]);
    if (parts[1] && /^\d{1,2}:\d{2}$/.test(parts[1])) departures.dir1.push(parts[1]);
  }
  fixPostMidnight(departures.dir0);
  fixPostMidnight(departures.dir1);
  return { routeLongName, serviceName, serviceStart, inStopName, outStopName, departures };
}

function fixPostMidnight(times) {
  let prevMinutes = -1;
  for (let i = 0; i < times.length; i++) {
    const [h, m] = times[i].split(':').map(Number);
    const minutes = h * 60 + m;
    if (minutes < prevMinutes && prevMinutes > 20 * 60) {
      times[i] = `${h + 24}:${String(m).padStart(2, '0')}`;
    }
    const [effH, effM] = times[i].split(':').map(Number);
    prevMinutes = effH * 60 + effM;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Step 3: time / distance helpers
// ──────────────────────────────────────────────────────────────────────────

function timeToSeconds(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

function formatGtfsTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Step 4: scrape + assemble
// ──────────────────────────────────────────────────────────────────────────

const allSchedules = [];
let fetched = 0;
let skipped = 0;
const routesWithoutCsv = [];

for (const route of seed.routes) {
  let hadAny = false;
  for (const svcKey of SERVICE_KEYS) {
    const csv = await fetchCsv(route.shortName, svcKey);
    if (!csv) { skipped++; continue; }
    const parsed = parseCtpCsv(csv);
    if (!parsed) { skipped++; continue; }
    const serviceId = SERVICE_MAP[svcKey];

    const dir0 = patternByRouteDir.get(`${route.routeId}|0`);
    const dir1 = patternByRouteDir.get(`${route.routeId}|1`);

    if (dir0 && parsed.departures.dir0.length > 0) {
      allSchedules.push({
        routeId: route.routeId,
        serviceId,
        departures: parsed.departures.dir0,
        dir: 0,
        stopSequence: dir0.stops,
        headsign: dir0.headsign || parsed.outStopName,
        shapeId: dir0.shapeId,
      });
      hadAny = true;
    }
    if (dir1 && parsed.departures.dir1.length > 0) {
      allSchedules.push({
        routeId: route.routeId,
        serviceId,
        departures: parsed.departures.dir1,
        dir: 1,
        stopSequence: dir1.stops,
        headsign: dir1.headsign || parsed.inStopName,
        shapeId: dir1.shapeId,
      });
      hadAny = true;
    }
    fetched++;
  }
  if (!hadAny) routesWithoutCsv.push(route);
}

LOG(`fetched ${fetched} CSVs, skipped ${skipped}`);
LOG(`schedule entries: ${allSchedules.length} (route × direction × service day)`);
if (routesWithoutCsv.length > 0) {
  LOG(`routes WITHOUT csv (${routesWithoutCsv.length}): ${routesWithoutCsv.map((r) => r.shortName).join(', ')}`);
}

if (allSchedules.length === 0) {
  console.error('[cluj-napoca] FATAL: no schedule data collected');
  process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────
// Step 5: generate output GTFS .txt files
// ──────────────────────────────────────────────────────────────────────────

const today = new Date();
const isoDate = today.toISOString().slice(0, 10);
const yyyymmdd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const startDateD = new Date(today.getFullYear(), today.getMonth(), 1);
const endDateD = new Date(today.getFullYear(), today.getMonth() + 6, 0);
const startDate = yyyymmdd(startDateD);
const endDate = yyyymmdd(endDateD);

const calendarTxt = [
  'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
  `LV,1,1,1,1,1,0,0,${startDate},${endDate}`,
  `S,0,0,0,0,0,1,0,${startDate},${endDate}`,
  `D,0,0,0,0,0,0,1,${startDate},${endDate}`,
  `LD,1,1,1,1,1,1,1,${startDate},${endDate}`,
].join('\n') + '\n';

const tripLines = ['route_id,service_id,trip_id,trip_headsign,direction_id,shape_id'];
const stLines = ['trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled'];

const TIMING = buildCfg.timing;

for (const s of allSchedules) {
  // Resolve every stop on this pattern to its {lat, lon} once per
  // schedule entry. Trips on the same pattern reuse this list.
  const orderedStops = s.stopSequence
    .map((st) => {
      const c = stopCoords.get(st.stopId);
      return c ? { stopId: st.stopId, lat: c.lat, lon: c.lon } : null;
    })
    .filter(Boolean);
  if (orderedStops.length !== s.stopSequence.length) {
    LOG(`  ⚠ ${s.routeId} dir=${s.dir} ${s.serviceId}: ${s.stopSequence.length - orderedStops.length} stop(s) missing coords`);
  }
  const shape = (s.shapeId && seed.shapesById.get(s.shapeId)) || [];

  for (let i = 0; i < s.departures.length; i++) {
    const depTime = s.departures[i];
    const tripId = `${s.routeId}_${s.dir}_${s.serviceId}_${i}_${depTime.replace(':', '')}`;
    const safeHeadsign = (s.headsign || '').replace(/,/g, ' ').replace(/"/g, '');
    tripLines.push(`${s.routeId},${s.serviceId},${tripId},${safeHeadsign},${s.dir},${s.shapeId || ''}`);

    const startSec = timeToSeconds(depTime);
    const { arrivals, departures, shapeDistTraveledM } = computeStopTimes({
      startSec,
      stops: orderedStops,
      shape,
      timing: TIMING,
    });
    for (let k = 0; k < orderedStops.length; k++) {
      const a = formatGtfsTime(arrivals[k]);
      const d = formatGtfsTime(departures[k]);
      stLines.push(
        `${tripId},${a},${d},${orderedStops[k].stopId},${k},${shapeDistTraveledM[k]}`,
      );
    }
  }
}

const tripsTxt = tripLines.join('\n') + '\n';
const stopTimesTxt = stLines.join('\n') + '\n';

const feedInfoTxt = [
  'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version',
  `neary-gtfs,https://github.com/ciotlosm/neary-gtfs,ro,${startDate},${endDate},${isoDate}`,
].join('\n') + '\n';

// ──────────────────────────────────────────────────────────────────────────
// Step 6: write seed pass-throughs + our regenerated files; re-zip
// ──────────────────────────────────────────────────────────────────────────

mkdirSync(OUTPUTS, { recursive: true });
const outZipPath = process.env.NEARY_OUTPUT_ZIP ?? join(OUTPUTS, 'cluj-napoca.gtfs.zip');

// Stage everything in the seed dir (which already has agency/routes/stops/shapes
// extracted). Overwrite the files we regenerate.
writeFileSync(join(seed.seedDir, 'calendar.txt'), calendarTxt);
writeFileSync(join(seed.seedDir, 'trips.txt'), tripsTxt);
writeFileSync(join(seed.seedDir, 'stop_times.txt'), stopTimesTxt);
writeFileSync(join(seed.seedDir, 'feed_info.txt'), feedInfoTxt);

const archiver = (await import('archiver')).default;
await new Promise((resolve, reject) => {
  const out = createWriteStream(outZipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  out.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(out);

  const include = [
    'agency.txt', 'routes.txt', 'stops.txt', 'shapes.txt',
    'calendar.txt', 'trips.txt', 'stop_times.txt', 'feed_info.txt',
    // optional pass-throughs if seed had them
    'calendar_dates.txt', 'transfers.txt', 'frequencies.txt',
    'fare_attributes.txt', 'fare_rules.txt', 'levels.txt', 'pathways.txt',
    'translations.txt', 'attributions.txt',
  ];
  for (const f of include) {
    const p = join(seed.seedDir, f);
    if (!existsSync(p)) continue;
    if (f === 'calendar.txt' || f === 'trips.txt' || f === 'stop_times.txt' || f === 'feed_info.txt') {
      // freshly regenerated
      archive.file(p, { name: f });
    } else {
      // pass-through from seed
      archive.file(p, { name: f });
    }
  }
  archive.finalize();
});

LOG(`output: ${outZipPath} (${(statSync(outZipPath).size / 1024).toFixed(1)} KB)`);
LOG(`trips=${tripLines.length - 1} stop_times=${stLines.length - 1}`);
LOG('done');
