/**
 * Seed loader: takes either an absolute path to a pre-fetched GTFS zip
 * (the pipeline hands us the Transitous-resolved Cluj-Napoca zip via
 * `NEARY_SEED_ZIP`) or a URL it will download. Extracts to a temp dir
 * and parses the standard GTFS .txt files into the in-memory shapes the
 * Cluj enhancement build expects.
 */

import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseCsv } from '../../../src/pipeline/lib/csv.js';
import { fetchToFile } from '../../../src/pipeline/lib/http.js';

const REQUIRED = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
const OPTIONAL = ['shapes.txt', 'calendar.txt', 'calendar_dates.txt', 'feed_info.txt'];

/**
 * @param {string} source  absolute file path OR http(s) URL
 */
export async function loadSeed(source) {
  const seedDir = mkdtempSync(join(tmpdir(), 'neary-ctp-seed-'));
  const zipPath = join(seedDir, 'seed.zip');

  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`[seed] fetching ${source}`);
    await fetchToFile(source, zipPath);
  } else {
    console.log(`[seed] using local ${source}`);
    copyFileSync(source, zipPath);
  }
  console.log(`[seed] zip size: ${(statSync(zipPath).size / 1024).toFixed(1)} KB`);

  // Extract everything to seedDir (flat — GTFS zips don't have subdirectories)
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', seedDir]);
  if (r.status !== 0) throw new Error(`unzip failed (status ${r.status})`);

  for (const f of REQUIRED) {
    try { statSync(join(seedDir, f)); }
    catch { throw new Error(`seed missing required file: ${f}`); }
  }

  const agencyTxt = readFileSync(join(seedDir, 'agency.txt'), 'utf8');
  const routesRows = parseCsv(readFileSync(join(seedDir, 'routes.txt'), 'utf8'));
  const stopsRows = parseCsv(readFileSync(join(seedDir, 'stops.txt'), 'utf8'));
  const tripsRows = parseCsv(readFileSync(join(seedDir, 'trips.txt'), 'utf8'));
  const stopTimesRows = parseCsv(readFileSync(join(seedDir, 'stop_times.txt'), 'utf8'));

  // shapes.txt is optional per GTFS, but the Cluj-Napoca Transitous
  // mirror always ships it. When present we group it by shape_id so
  // the build step can project each trip's stops onto its polyline
  // (replaces straight-line haversine for stop-to-stop distance).
  let shapesById = new Map();
  try {
    statSync(join(seedDir, 'shapes.txt'));
    const shapesRows = parseCsv(readFileSync(join(seedDir, 'shapes.txt'), 'utf8'));
    const byId = new Map();
    for (const row of shapesRows) {
      const id = row.shape_id;
      if (!id) continue;
      const lat = parseFloat(row.shape_pt_lat);
      const lon = parseFloat(row.shape_pt_lon);
      const seq = parseInt(row.shape_pt_sequence, 10);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(seq)) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push({ lat, lon, seq });
    }
    for (const arr of byId.values()) {
      arr.sort((a, b) => a.seq - b.seq);
      // Strip the helper `seq` field — consumers only need lat/lon.
      for (const p of arr) delete p.seq;
    }
    shapesById = byId;
  } catch {
    // No shapes.txt in seed — leave shapesById empty and let the
    // build fall back to haversine.
  }

  const routes = routesRows.map((r) => ({
    routeId: r.route_id,
    shortName: r.route_short_name,
    longName: r.route_long_name,
    type: r.route_type,
    color: r.route_color || '',
  }));

  const stops = stopsRows.map((s) => ({
    stopId: s.stop_id,
    name: s.stop_name,
    lat: parseFloat(s.stop_lat),
    lon: parseFloat(s.stop_lon),
  }));

  const trips = tripsRows.map((t) => ({
    tripId: t.trip_id,
    routeId: t.route_id,
    directionId: t.direction_id ? Number(t.direction_id) : 0,
    headsign: t.trip_headsign || '',
    shapeId: t.shape_id || '',
    serviceId: t.service_id,
  }));

  // Group stop_times by trip_id; sort by stop_sequence
  const stopTimes = new Map();
  for (const st of stopTimesRows) {
    const entry = { stopId: st.stop_id, sequence: parseInt(st.stop_sequence, 10) };
    if (!stopTimes.has(st.trip_id)) stopTimes.set(st.trip_id, []);
    stopTimes.get(st.trip_id).push(entry);
  }
  for (const arr of stopTimes.values()) arr.sort((a, b) => a.sequence - b.sequence);

  console.log(`[seed] parsed: ${routes.length} routes, ${stops.length} stops, ${trips.length} trips, ${stopTimesRows.length} stop_times`);

  return { seedDir, agencyTxt, routes, stops, trips, stopTimes, shapesById, optional: OPTIONAL };
}
