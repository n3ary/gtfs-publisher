#!/usr/bin/env node

/**
 * build-all.js — daily orchestrator.
 *
 *   1. resolve-feeds       — what are we publishing today?
 *   2. for each feed: fetch-gtfs   (download from upstream URL)
 *                     validate     (remote only — light spec-shape check)
 *                     smoke        (remote only — per-feed contract check)
 *                     derive-bbox  (read stops/agency/feed_info.txt)
 *                     make-sqlite  (gtfs.zip → sqlite3.gz)
 *   3. make-app-registry → outputs/feeds.json (schema-validated)
 *
 * Output layout (under `outputs/`):
 *   outputs/feeds.json
 *   outputs/<id>-<hash12>.sqlite3.gz  — content-addressed URL
 *
 * Publish: .github/workflows/daily.yml uploads outputs/ to Cloudflare R2.
 *
 * Note: the .gtfs.zip is unlinked after make-sqlite — consumers that
 * want the raw zip fetch it from the upstream URL directly.
 */

import { resolveFeeds } from './resolve-feeds.js';
import { fetchGtfs } from './fetch-gtfs.js';
import { deriveBbox } from './derive-bbox.js';
import { makeSqlite } from './make-sqlite.js';
import { makeAppRegistry } from './make-app-registry.js';
import { validate } from './validate.js';
import { smokeTestRemote } from './smoke-remote.js';
import { UA } from './lib/http.js';

import { existsSync, unlinkSync } from 'node:fs';

const DEFAULT_PUBLIC_BASE_URL = 'https://gtfs.n3ary.com';
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
const PREV_REGISTRY_URL = `${PUBLIC_BASE_URL}/feeds.json`;

/**
 * Fetch the previously-published feeds.json from the live CDN. Returns
 * a Map<id, prevEntry> so we can check whether an upstream zip changed
 * since last run and skip rebuilding when it didn't.
 */
async function fetchPreviousRegistry() {
  try {
    const res = await fetch(PREV_REGISTRY_URL, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn(`[build-all] previous registry: HTTP ${res.status} — full rebuild`);
      return new Map();
    }
    const reg = await res.json();
    return new Map(reg.feeds.map((f) => [f.id, f]));
  } catch (err) {
    console.warn(`[build-all] previous registry: ${err.message} — full rebuild`);
    return new Map();
  }
}

/** HEAD an upstream URL, return its ETag (or null on failure). */
async function fetchUpstreamEtag(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return res.headers.get('etag');
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  const feeds = await resolveFeeds();
  const prev = await fetchPreviousRegistry();
  console.log(`[build-all] processing ${feeds.length} feed(s); previous registry has ${prev.size}`);

  const entries = [];
  let reused = 0;

  for (const feed of feeds) {
    console.log(`\n=== ${feed.id} (${feed.source.type}) ===`);

    // Skip-on-unchanged: if upstream ETag is unchanged AND we already
    // shipped a hash-versioned sqlite_gz for this feed, pass the previous
    // entry through. Bypassed when FORCE_REBUILD is set (use after
    // pipeline code changes that affect output but don't touch the
    // upstream feed).
    //
    // The `hashedFilename` check auto-migrates any old-shape entry
    // (`<id>.sqlite3.gz` without hash suffix) by forcing a rebuild the
    // first time a run sees it after switching to content-addressed
    // URLs. Steady state after migration: all entries pass the check.
    const prevEntry = prev.get(feed.id);
    const prevEtag = prevEntry?.source?.upstream_etag;
    const prevFile = prevEntry?.files?.sqlite_gz;
    const hashedFilename = typeof prevFile === 'string' &&
      new RegExp(`^${feed.id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-[0-9a-f]{12}\\.sqlite3\\.gz$`).test(prevFile);
    const currentEtag = await fetchUpstreamEtag(feed.source.upstream_url);
    const forceRebuild = !!process.env.FORCE_REBUILD;
    if (!forceRebuild && prevEtag && currentEtag === prevEtag && hashedFilename) {
      console.log(`[build-all] ${feed.id}: upstream unchanged (ETag ${currentEtag}) — reusing previous build`);
      entries.push({ reused: true, prevEntry });
      reused++;
      continue;
    }
    if (forceRebuild && prevEtag && currentEtag === prevEtag) {
      console.log(`[build-all] ${feed.id}: upstream unchanged (ETag ${currentEtag}) but FORCE_REBUILD set — rebuilding`);
    } else if (prevEtag && currentEtag === prevEtag && !hashedFilename) {
      console.log(`[build-all] ${feed.id}: upstream unchanged but previous entry has legacy filename shape — rebuilding to migrate`);
    } else if (prevEtag) {
      console.log(`[build-all] ${feed.id}: upstream changed (${prevEtag} → ${currentEtag ?? 'null'}) — rebuilding`);
    }
    feed._currentEtag = currentEtag;

    try {
      const gtfs = await fetchGtfs(feed);

      if (feed.source.type === 'remote') {
        const { warnings } = validate(gtfs.localPath);
        for (const w of warnings) console.warn(`[validate] ${feed.id}: WARN ${w}`);
        const { checks } = smokeTestRemote(gtfs.localPath, feed._smoke);
        for (const c of checks) console.log(`[smoke] ${feed.id}: OK ${c}`);
      }

      const meta = deriveBbox(gtfs.localPath);
      const sqlite = await makeSqlite(gtfs.localPath, feed.id);

      // The raw .gtfs.zip isn't republished — consumers fetch it from the
      // upstream URL recorded in source.upstream_url.
      if (existsSync(gtfs.localPath)) {
        unlinkSync(gtfs.localPath);
        gtfs.localPath = null;
        gtfs.sizeBytes = null;
        gtfs.hash = null;
      }

      entries.push({
        feed, gtfs, sqlite,
        upstreamEtag: feed._currentEtag ?? null,
        ...meta,
      });
      console.log(
        `[build-all] ${feed.id}: bbox=[${meta.bbox.minLat},${meta.bbox.minLon}]..[${meta.bbox.maxLat},${meta.bbox.maxLon}], sqlite_gz=${sqlite ? (sqlite.sizeBytes / 1024).toFixed(1) + 'KB' : 'n/a'}`,
      );
    } catch (err) {
      console.error(`[build-all] ${feed.id}: FAILED — ${err.message}`);
      if (process.env.STRICT === 'true') throw err;
    }
  }

  if (entries.length === 0) {
    throw new Error('no feeds built successfully');
  }
  makeAppRegistry(entries);

  console.log(
    `\n[build-all] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${entries.length - reused} fresh, ${reused} reused, ${entries.length}/${feeds.length} total`,
  );
}

main().catch((err) => {
  console.error('[build-all] fatal:', err);
  process.exit(1);
});
