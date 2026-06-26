/**
 * smoke-test for M1 pipeline (minus the legacy build invocation).
 *
 * Run with: `node src/pipeline/_smoke.js`
 *
 * Validates derive-bbox + make-app-registry against an existing
 * GTFS zip at outputs/feeds/ctp-cluj.gtfs.zip. Used for local
 * verification before pushing CI.
 */

import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveBbox } from './derive-bbox.js';
import { makeAppRegistry } from './make-app-registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const zip = join(ROOT, 'outputs', 'feeds', 'ctp-cluj.gtfs.zip');
const sizeBytes = statSync(zip).size;
const hash = 'sha256-' + createHash('sha256').update(readFileSync(zip)).digest('hex');

const meta = deriveBbox(zip);
console.log('[smoke] derive-bbox →', JSON.stringify(meta, null, 2));

const feed = {
  id: 'ctp-cluj',
  name: 'Cluj-Napoca',
  country: 'RO',
  region: 'Cluj',
  timezone: 'Europe/Bucharest',
  languages: ['ro'],
  source: { type: 'build', publisher: 'neary-gtfs', upstream_url: null },
  agencies: [],
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

const registry = makeAppRegistry([
  {
    feed,
    gtfs: { localPath: zip, sizeBytes, hash },
    sqlite: null,
    ...meta,
  },
]);

console.log('[smoke] feeds.json[0]:', JSON.stringify(registry.feeds[0], null, 2));
