#!/usr/bin/env node

/**
 * diff-cluj-arrivals.mjs — proof script for the shape-aware /
 * time-of-day-aware Cluj timing change.
 *
 * Loads the Cluj seed (via $NEARY_SEED_ZIP, falling back to the
 * Transitous mirror), picks a representative trip on $ROUTE
 * (default "24") in direction $DIRECTION (default 0), and prints
 * stop-by-stop arrival/departure times computed by:
 *
 *   OLD: haversine between adjacent stops + 18 km/h flat speed +
 *        the [60s, 300s]-per-stop duration clamp + no dwell.
 *   NEW: shape-projected distance + time-of-day speed bucket +
 *        20s intermediate-stop dwell.
 *
 * Run two simulated origin departures: one in morning peak (08:30)
 * and one off-peak (12:00) so the speed-bucket effect is visible.
 *
 * Usage:
 *   NEARY_SEED_ZIP=/path/to/seed.zip node scripts/diff-cluj-arrivals.mjs
 *   ROUTE=24 DIRECTION=0 node scripts/diff-cluj-arrivals.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSeed } from '../feeds/cluj-napoca/lib/seed.js';
import { computeStopTimes } from '../feeds/cluj-napoca/lib/timing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const ROUTE = process.env.ROUTE ?? '24';
const DIRECTION = process.env.DIRECTION ?? '0';
const SEED_SOURCE =
  process.env.NEARY_SEED_ZIP ?? 'https://api.transitous.org/gtfs/ro_Cluj-Napoca.gtfs.zip';

const config = JSON.parse(
  readFileSync(join(REPO_ROOT, 'feeds', 'cluj-napoca', 'config.json'), 'utf8'),
);
const TIMING = config.build.timing;

// ── OLD algorithm — kept here as a faithful copy of what used to
//    live in feeds/cluj-napoca/build.js. Do not "improve" it; the
//    whole point is to compare against the prior behaviour.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function oldInterpolateStopTimes(startSec, stops, avgSpeedKmh = 18) {
  const n = stops.length;
  if (n <= 1) return { arrivals: [startSec], departures: [startSec] };
  const cumDist = [0];
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    cumDist.push(total);
  }
  const totalDurationSec = Math.round((total / 1000 / avgSpeedKmh) * 3600);
  const bounded = Math.max(n * 60, Math.min(n * 300, totalDurationSec));
  const times = [];
  for (let i = 0; i < n; i++) {
    const fraction = total > 0 ? cumDist[i] / total : i / (n - 1);
    times.push(startSec + Math.round(fraction * bounded));
  }
  return { arrivals: times, departures: times };
}

function fmt(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// ── main
const seed = await loadSeed(SEED_SOURCE);

const stopCoords = new Map(seed.stops.map((s) => [s.stopId, { lat: s.lat, lon: s.lon, name: s.name }]));
const route = seed.routes.find((r) => r.shortName === ROUTE);
if (!route) {
  console.error(`No route with short_name="${ROUTE}" in seed.`);
  process.exit(1);
}
const trip = seed.trips.find((t) => t.routeId === route.routeId && String(t.directionId) === DIRECTION);
if (!trip) {
  console.error(`No trip on route ${ROUTE} dir=${DIRECTION}.`);
  process.exit(1);
}
const stopList = seed.stopTimes.get(trip.tripId) ?? [];
const stops = stopList.map((s) => {
  const c = stopCoords.get(s.stopId);
  return c ? { stopId: s.stopId, name: c.name, lat: c.lat, lon: c.lon } : null;
}).filter(Boolean);

const shape = (trip.shapeId && seed.shapesById.get(trip.shapeId)) || [];

console.log('\n──────────────────────────────────────────────────────────────');
console.log(`Route ${ROUTE} dir=${DIRECTION}  trip=${trip.tripId}  shape=${trip.shapeId || '(none)'}`);
console.log(`Stops: ${stops.length}  Shape vertices: ${shape.length}`);
console.log('──────────────────────────────────────────────────────────────');

function compareAt(startSec, label) {
  const oldR = oldInterpolateStopTimes(startSec, stops);
  const newR = computeStopTimes({ startSec, stops, shape, timing: TIMING });
  console.log(`\n${label}  (start ${fmt(startSec)})`);
  console.log(`Speed bucket NEW: ${newR.speedBucket} (${newR.speedKmh} km/h)`);
  console.log(
    pad('#', 4) + pad('stop', 32) +
    pad('OLD arr', 11) + pad('NEW arr', 11) +
    pad('NEW dep', 11) + pad('shape_dist_m', 14),
  );
  for (let i = 0; i < stops.length; i++) {
    console.log(
      pad(String(i), 4) +
      pad((stops[i].name ?? '').slice(0, 30), 32) +
      pad(fmt(oldR.arrivals[i]), 11) +
      pad(fmt(newR.arrivals[i]), 11) +
      pad(fmt(newR.departures[i]), 11) +
      pad(String(newR.shapeDistTraveledM[i]), 14),
    );
  }
  const oldDuration = oldR.arrivals[stops.length - 1] - oldR.arrivals[0];
  const newDuration = newR.arrivals[stops.length - 1] - newR.arrivals[0];
  console.log(`Total duration  OLD: ${Math.round(oldDuration / 60)} min  NEW: ${Math.round(newDuration / 60)} min`);
}

compareAt(8 * 3600 + 30 * 60, '── PEAK (08:30) ─────────────────────────────────────────────');
compareAt(12 * 3600,            '── OFFPEAK (12:00) ──────────────────────────────────────────');
compareAt(1 * 3600 + 30 * 60,   '── NIGHT (01:30) ────────────────────────────────────────────');
