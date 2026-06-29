/**
 * fetch-gtfs.js — download a GTFS .zip for one feed.
 *
 *   source.type === "transitous" → api.transitous.org/gtfs/<iso>_<name>.gtfs.zip
 *   source.type === "remote"     → feed.source.upstream_url
 *                                  (a fully pre-built GTFS zip from another
 *                                  repo, e.g. cluj-napoca-gtfs-adapter).
 *
 * Returns: { localPath, sizeBytes, hash } for downstream stages.
 */

import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { fetchToFile } from './lib/http.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUTS = join(ROOT, 'outputs');

const TRANSITOUS_GTFS_BASE = 'https://api.transitous.org/gtfs';

function transitousUrl(iso, name) {
  return `${TRANSITOUS_GTFS_BASE}/${iso.toLowerCase()}_${encodeURIComponent(name)}.gtfs.zip`;
}

function sha256(filePath) {
  return 'sha256-' + createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * @param {object} feed - resolved feed object from resolve-feeds.js
 * @returns {Promise<{ localPath: string, sizeBytes: number, hash: string }>}
 */
export async function fetchGtfs(feed) {
  mkdirSync(OUTPUTS, { recursive: true });
  const dest = join(OUTPUTS, `${feed.id}.gtfs.zip`);

  let upstream;
  if (feed.source.type === 'transitous') {
    upstream = transitousUrl(feed.country, feed.name);
  } else if (feed.source.type === 'remote') {
    upstream = feed.source.upstream_url;
  } else {
    throw new Error(`feed ${feed.id}: unknown source.type "${feed.source.type}"`);
  }

  console.log(`[fetch-gtfs] ${feed.id} ← ${upstream}`);
  await fetchToFile(upstream, dest);

  return { localPath: dest, sizeBytes: statSync(dest).size, hash: sha256(dest) };
}
