/**
 * resolve-feeds.js — resolve the set of feeds we'll build/publish.
 *
 * Reads countries.json → for each ISO code, fetches the Transitous
 * `feeds/<iso>.json` from public-transport/transitous@main. Returns a
 * flat list of { id, name, country, source, realtime, license } that
 * the rest of the pipeline iterates over.
 *
 * Special case: our own ctp-cluj feed is always prepended. Its
 * `source.type` is "build" — the pipeline runs `feeds/ctp-cluj/build.js`
 * (legacy `src/build.js` until M2) to produce the GTFS .zip locally.
 *
 * M1 scope note: only ctp-cluj is emitted by default — the
 * `RESOLVE_INCLUDE_TRANSITOUS=true` env flag opts into Transitous
 * resolution for testing. M2 flips this on by default with the first
 * non-Cluj feed (Bucharest).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const TRANSITOUS_RAW = 'https://raw.githubusercontent.com/public-transport/transitous/main/feeds';

/** Our locally-built feed. The pipeline shells out to `feeds/ctp-cluj/build.js`. */
const CTP_CLUJ_FEED = {
  id: 'ctp-cluj',
  name: 'Cluj-Napoca',
  country: 'RO',
  region: 'Cluj',
  timezone: 'Europe/Bucharest',
  languages: ['ro'],
  source: { type: 'build', publisher: 'neary-gtfs', upstream_url: null },
  agencies: [
    {
      agency_id: '2',
      agency_name: 'Compania de Transport Public Cluj-Napoca',
      agency_url: 'https://www.ctpcluj.ro/',
    },
  ],
  realtime: {
    vehicle_positions: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions',
    trip_updates: 'https://cluj-rt-feed.gtfs.ro/tripUpdates',
    service_alerts: 'https://cluj-rt-feed.gtfs.ro/serviceAlerts',
  },
  license: {
    spdx_identifier: 'CC-BY-SA-4.0',
    attribution_text: '© Compania de Transport Public Cluj-Napoca',
    attribution_url: 'https://www.ctpcluj.ro/',
  },
};

async function fetchTransitousCountry(iso) {
  const url = `${TRANSITOUS_RAW}/${iso}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)' },
  });
  if (!res.ok) throw new Error(`Transitous fetch failed for ${iso}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Project a Transitous `sources[]` entry into our feed shape.
 *
 * Transitous schema (abbreviated):
 *   { name, type: "http"|"transitland-atlas"|..., url?, license, fix? }
 *
 * We're only interested in entries that resolve to a downloadable GTFS
 * zip — everything else is skipped with a warning.
 */
function projectTransitousFeed(iso, raw) {
  if (!raw.name) return { skip: 'missing name' };
  if (raw.type !== 'http' && raw.type !== 'transitland-atlas' && raw.type !== 'mobility-database') {
    return { skip: `unsupported source type: ${raw.type}` };
  }

  const id = String(raw.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

  return {
    feed: {
      id,
      name: raw.name,
      country: iso.toUpperCase(),
      region: null,
      timezone: null, // derived later from feed_info.txt or upstream metadata
      languages: [],
      source: {
        type: 'transitous',
        publisher: `Transitous (${raw.type})`,
        upstream_url: raw.url ?? null,
      },
      agencies: [], // populated by fetch-gtfs after we read agency.txt
      realtime: null,
      license: {
        spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
        attribution_text: raw.license?.['attribution-text'] ?? raw.name,
        attribution_url: raw.license?.['url'] ?? null,
      },
    },
  };
}

/**
 * @returns {Promise<Array<object>>} resolved feeds in build order.
 *   ctp-cluj is always first; Transitous entries follow.
 */
export async function resolveFeeds() {
  const config = JSON.parse(readFileSync(join(ROOT, 'countries.json'), 'utf8'));
  const countries = config.countries ?? [];
  const includeTransitous = process.env.RESOLVE_INCLUDE_TRANSITOUS === 'true';

  const feeds = [CTP_CLUJ_FEED];

  if (!includeTransitous) {
    console.log('[resolve-feeds] M1 mode: ctp-cluj only (set RESOLVE_INCLUDE_TRANSITOUS=true to mirror Transitous).');
    return feeds;
  }

  for (const iso of countries) {
    let payload;
    try {
      payload = await fetchTransitousCountry(iso);
    } catch (err) {
      console.warn(`[resolve-feeds] skipping ${iso}: ${err.message}`);
      continue;
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    for (const raw of sources) {
      const projected = projectTransitousFeed(iso, raw);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name ?? '?'}: skipped (${projected.skip})`);
        continue;
      }
      // De-duplicate: a Cluj-published-via-Transitous entry shouldn't double
      // when our own ctp-cluj is already in the list.
      if (projected.feed.id === 'ctp-cluj' || projected.feed.id.startsWith('cluj-napoca')) {
        console.log(`[resolve-feeds] ${iso}/${raw.name}: skipped (overlaps our own ctp-cluj feed)`);
        continue;
      }
      feeds.push(projected.feed);
    }
  }

  console.log(`[resolve-feeds] resolved ${feeds.length} feed(s).`);
  return feeds;
}
