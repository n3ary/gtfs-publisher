/**
 * fetch-gtfs.js — produce a GTFS .zip on disk for one feed.
 *
 *   source.type === "build"      → spawn the feed's own `build.js`
 *                                  (path from feeds/<id>/config.json's
 *                                  build.script, default "build.js").
 *                                  The script is expected to write its
 *                                  output to outputs/feeds/<id>.gtfs.zip.
 *   source.type === "transitous" → download
 *                                  api.transitous.org/gtfs/<iso>_<name>.gtfs.zip
 *
 * Returns: { localPath, sizeBytes, hash } for downstream stages.
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!ws.write(value)) await new Promise((r) => ws.once('drain', r));
  }
  await new Promise((r) => ws.end(r));
}

function runLocalBuild(feed, outputZipPath) {
  const feedDir = feed._enhances?.feedDir;
  if (!feedDir) throw new Error(`feed ${feed.id}: source.type=build but no _enhances.feedDir`);
  const cfg = JSON.parse(readFileSync(join(ROOT, 'feeds', feedDir, 'config.json'), 'utf8'));
  const script = cfg.build?.script ?? 'build.js';
  const rel = join('feeds', feedDir, script);

  const env = { ...process.env, NEARY_OUTPUT_ZIP: outputZipPath };
  if (feed._seedZipPath) env.NEARY_SEED_ZIP = feed._seedZipPath;

  console.log(`[fetch-gtfs] ${feed.id} ← node ${rel}${env.NEARY_SEED_ZIP ? ` (seed: ${env.NEARY_SEED_ZIP})` : ''}`);
  const r = spawnSync('node', [rel], { cwd: ROOT, stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`local build for ${feed.id} failed (exit ${r.status})`);
}

/**
 * @param {object} feed - resolved feed object from resolve-feeds.js
 * @returns {Promise<{ localPath: string, sizeBytes: number, hash: string }>}
 */
export async function fetchGtfs(feed) {
  mkdirSync(OUTPUTS, { recursive: true });
  const dest = join(OUTPUTS, `${feed.id}.gtfs.zip`);

  if (feed.source.type === 'build') {
    if (feed._enhances) {
      const { iso, transitousName } = feed._enhances;
      const seedUrl = `${TRANSITOUS_GTFS_BASE}/${iso.toLowerCase()}_${encodeURIComponent(transitousName)}.gtfs.zip`;
      const seedDest = join(OUTPUTS, `${feed.id}.seed.gtfs.zip`);
      console.log(`[fetch-gtfs] ${feed.id} seed ← ${seedUrl}`);
      await fetchToFile(seedUrl, seedDest);
      feed._seedZipPath = seedDest;
    }
    runLocalBuild(feed, dest);
    if (feed._seedZipPath && existsSync(feed._seedZipPath)) unlinkSync(feed._seedZipPath);
  } else if (feed.source.type === 'transitous') {
    const isoLower = (feed.country || '').toLowerCase();
    const upstream = `${TRANSITOUS_GTFS_BASE}/${isoLower}_${encodeURIComponent(feed.name)}.gtfs.zip`;
    console.log(`[fetch-gtfs] ${feed.id} ← ${upstream}`);
    await fetchToFile(upstream, dest);
  } else {
    throw new Error(`feed ${feed.id}: unknown source.type "${feed.source.type}"`);
  }

  const sizeBytes = statSync(dest).size;
  const hash = sha256(dest);
  return { localPath: dest, sizeBytes, hash };
}
