/**
 * fetch-gtfs.js — produce a GTFS .zip on disk for one feed.
 *
 * - source.type === "build" (ctp-cluj): shells out to the legacy
 *   `src/build.js` which is unchanged from M0. Copies its output zip
 *   into outputs/feeds/<id>.gtfs.zip.
 * - source.type === "transitous" / "mobility-database": fetches from
 *   `api.transitous.org/gtfs/<name>.gtfs.zip` (M2+) or from the raw
 *   `source.upstream_url` directly. Stored under outputs/feeds/<id>.gtfs.zip.
 *
 * Returns: { localPath, sizeBytes, hash } for downstream stages.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUTS = join(ROOT, 'outputs', 'feeds');

const TRANSITOUS_GTFS_BASE = 'https://api.transitous.org/gtfs';

function sha256(filePath) {
  const buf = readFileSync(filePath);
  return 'sha256-' + createHash('sha256').update(buf).digest('hex');
}

async function fetchToFile(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)' },
  });
  if (!res.ok || !res.body) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const ws = createWriteStream(dest);
  const reader = res.body.getReader();
  // Node 24+: Readable.from(asyncIterable) would be tidier, but this works.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!ws.write(value)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
}

/**
 * Build the ctp-cluj GTFS by invoking the legacy build script.
 * Until M2 this stays at src/build.js with its current Tranzy-registry
 * dependency. The build's output zip lives at output/agency-2/agency-2-gtfs.zip
 * which we copy into outputs/feeds/ctp-cluj.gtfs.zip.
 */
function buildCtpCluj() {
  const result = spawnSync('node', ['src/build.js', '--agency', '2'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`ctp-cluj build failed (exit code ${result.status})`);
  }
  const src = join(ROOT, 'output', 'agency-2', 'agency-2-gtfs.zip');
  const dest = join(OUTPUTS, 'ctp-cluj.gtfs.zip');
  mkdirSync(OUTPUTS, { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

/**
 * @param {object} feed - resolved feed object from resolve-feeds.js
 * @returns {Promise<{ localPath: string, sizeBytes: number, hash: string }>}
 */
export async function fetchGtfs(feed) {
  mkdirSync(OUTPUTS, { recursive: true });
  const dest = join(OUTPUTS, `${feed.id}.gtfs.zip`);

  if (feed.source.type === 'build' && feed.id === 'ctp-cluj') {
    buildCtpCluj();
  } else if (feed.source.type === 'transitous') {
    const upstream =
      feed.source.upstream_url ?? `${TRANSITOUS_GTFS_BASE}/${encodeURIComponent(feed.name)}.gtfs.zip`;
    console.log(`[fetch-gtfs] ${feed.id} ← ${upstream}`);
    await fetchToFile(upstream, dest);
  } else if (feed.source.type === 'mobility-database') {
    throw new Error(`feed ${feed.id}: direct mobility-database fetch not implemented (use Transitous as the intermediary)`);
  } else {
    throw new Error(`feed ${feed.id}: unknown source.type "${feed.source.type}"`);
  }

  const sizeBytes = statSync(dest).size;
  const hash = sha256(dest);
  return { localPath: dest, sizeBytes, hash };
}
