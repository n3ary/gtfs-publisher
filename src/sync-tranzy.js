#!/usr/bin/env node

/**
 * Sync all static data from the Tranzy API for all agencies.
 *
 * Usage:
 *   TRANZY_API_KEY=<key> node src/sync-tranzy.js
 *
 * Environment:
 *   TRANZY_API_KEY  — required
 *
 * What it does:
 *   1. Fetches /agency to discover all agencies
 *   2. For each agency: fetches /routes, /stops, /trips, /stop_times, /shapes
 *   3. Hashes each response — only writes to disk if content changed
 *   4. Stores raw JSON responses in data/<agency_id>/<endpoint>.json
 *   5. Writes a hash manifest (data/hashes.json) for change detection
 *   6. Updates the transformed registry files that build.js expects
 *      (agencies/<id>/routes.json, stops.json, trips.json, stop_times.json)
 *
 * The raw files in data/ are the source of truth for the neary app's static
 * data (served from the releases branch). The registry files in agencies/
 * are the intermediate format consumed by the offline schedule builder.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_KEY = process.env.TRANZY_API_KEY;
if (!API_KEY) {
  console.error('Error: TRANZY_API_KEY environment variable is required');
  process.exit(1);
}

const BASE_URL = 'https://api.tranzy.ai/v1/opendata';
const LOG = (msg) => console.log(`[sync-tranzy] ${msg}`);

// ============================================================================
// Hashing
// ============================================================================

function hashContent(data) {
  const json = JSON.stringify(data);
  return createHash('sha256').update(json).digest('hex');
}

function loadPreviousHashes() {
  const hashFile = join(ROOT, 'data', 'hashes.json');
  if (!existsSync(hashFile)) return {};
  try {
    return JSON.parse(readFileSync(hashFile, 'utf8'));
  } catch {
    return {};
  }
}

// ============================================================================
// Fetching
// ============================================================================

async function fetchJson(endpoint, agencyId = null) {
  const url = `${BASE_URL}/${endpoint}`;
  const headers = { 'X-API-Key': API_KEY };
  if (agencyId) headers['X-Agency-Id'] = String(agencyId);

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    throw new Error(`${endpoint} (agency ${agencyId}) → HTTP ${res.status}`);
  }
  return res.json();
}

// ============================================================================
// Storage helpers
// ============================================================================

function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data));
}

function writeJsonPretty(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================================================
// Registry generation (for build.js compatibility)
// ============================================================================

function writeRegistry(agencyId, rawRoutes, rawStops, rawTrips, rawStopTimes) {
  const outDir = join(ROOT, 'agencies', String(agencyId));
  mkdirSync(outDir, { recursive: true });

  const routes = {
    _comment: `Auto-generated from Tranzy /routes API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    routes: rawRoutes
      .map(r => ({
        shortName: r.route_short_name,
        routeId: r.route_id,
        longName: r.route_long_name,
        type: r.route_type,
      }))
      .sort((a, b) => a.routeId - b.routeId),
  };
  writeJsonPretty(join(outDir, 'routes.json'), routes);

  const stops = {
    _comment: `Auto-generated from Tranzy /stops API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    stops: rawStops
      .map(s => ({
        stopId: s.stop_id,
        name: s.stop_name,
        lat: s.stop_lat,
        lon: s.stop_lon,
      }))
      .sort((a, b) => a.stopId - b.stopId),
  };
  writeJsonPretty(join(outDir, 'stops.json'), stops);

  const trips = {
    _comment: `Auto-generated from Tranzy /trips API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    trips: rawTrips
      .map(t => ({
        tripId: t.trip_id,
        routeId: t.route_id,
        directionId: t.direction_id,
        headsign: t.trip_headsign,
        shapeId: t.shape_id,
        serviceId: t.service_id,
      }))
      .sort((a, b) => a.routeId - b.routeId || a.directionId - b.directionId),
  };
  writeJsonPretty(join(outDir, 'trips.json'), trips);

  const byTrip = {};
  for (const st of rawStopTimes) {
    if (!byTrip[st.trip_id]) byTrip[st.trip_id] = [];
    byTrip[st.trip_id].push({ stopId: st.stop_id, sequence: st.stop_sequence });
  }
  for (const tripId of Object.keys(byTrip)) {
    byTrip[tripId].sort((a, b) => a.sequence - b.sequence);
  }
  const stopTimes = {
    _comment: `Auto-generated from Tranzy /stop_times API for agency_id=${agencyId}`,
    _generated: new Date().toISOString(),
    stopTimes: byTrip,
  };
  writeJsonPretty(join(outDir, 'stop_times.json'), stopTimes);

  return { routes: routes.routes.length, stops: stops.stops.length, trips: trips.trips.length };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const previousHashes = loadPreviousHashes();
  const newHashes = {};
  let changedCount = 0;
  let unchangedCount = 0;

  LOG('Fetching agency list...');
  const agencies = await fetchJson('agency');
  LOG(`Found ${agencies.length} agencies`);

  // Check + store agency list
  const dataDir = join(ROOT, 'data');
  const agencyHash = hashContent(agencies);
  newHashes['agency'] = agencyHash;
  if (agencyHash !== previousHashes['agency']) {
    writeJson(join(dataDir, 'agency.json'), agencies);
    LOG(`✓ data/agency.json (changed)`);
    changedCount++;
  } else {
    LOG(`– data/agency.json (unchanged)`);
    unchangedCount++;
  }

  // Process each agency
  const ENDPOINTS = ['routes', 'stops', 'trips', 'stop_times', 'shapes'];

  for (const agency of agencies) {
    const id = agency.agency_id;
    const name = agency.agency_name;
    const agencyDataDir = join(dataDir, String(id));

    LOG(`\n── Agency ${id}: ${name} ──`);

    const fetched = {};
    let agencyChanged = false;

    try {
      for (const endpoint of ENDPOINTS) {
        LOG(`  Fetching ${endpoint}...`);
        const data = await fetchJson(endpoint, id);
        fetched[endpoint] = data;

        const hashKey = `${id}/${endpoint}`;
        const hash = hashContent(data);
        newHashes[hashKey] = hash;

        if (hash !== previousHashes[hashKey]) {
          mkdirSync(agencyDataDir, { recursive: true });
          writeJson(join(agencyDataDir, `${endpoint}.json`), data);
          LOG(`  ✓ ${endpoint}: ${Array.isArray(data) ? data.length : '?'} (changed)`);
          changedCount++;
          agencyChanged = true;
        } else {
          LOG(`  – ${endpoint}: ${Array.isArray(data) ? data.length : '?'} (unchanged)`);
          unchangedCount++;
        }
      }

      // Update registry files only if any data changed for this agency
      if (agencyChanged) {
        const stats = writeRegistry(
          id,
          fetched.routes,
          fetched.stops,
          fetched.trips,
          fetched.stop_times,
        );
        LOG(`  ✓ registry updated: ${stats.routes} routes, ${stats.stops} stops, ${stats.trips} trips`);
      }

    } catch (err) {
      LOG(`  ✗ ERROR: ${err.message}`);
      // Preserve previous hashes for failed agencies
      for (const endpoint of ENDPOINTS) {
        const hashKey = `${id}/${endpoint}`;
        if (previousHashes[hashKey]) {
          newHashes[hashKey] = previousHashes[hashKey];
        }
      }
    }
  }

  // Write hash manifest
  mkdirSync(dataDir, { recursive: true });
  writeJsonPretty(join(dataDir, 'hashes.json'), newHashes);

  LOG(`\nSync complete: ${changedCount} changed, ${unchangedCount} unchanged.`);

  // Set output for CI: did anything change?
  if (changedCount > 0) {
    LOG('STATIC_DATA_CHANGED=true');
    // Write marker file for workflow
    writeFileSync(join(dataDir, 'CHANGED'), `${changedCount} files changed\n`);
  } else {
    LOG('STATIC_DATA_CHANGED=false');
  }
}

main().catch(err => {
  console.error('[sync-tranzy] Fatal:', err.message);
  process.exit(1);
});
