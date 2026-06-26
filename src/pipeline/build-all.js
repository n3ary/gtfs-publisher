#!/usr/bin/env node

/**
 * build-all.js — daily orchestrator.
 *
 *   1. resolve-feeds       — what are we building today?
 *   2. for each feed: fetch-gtfs   (build locally or download upstream)
 *                     derive-bbox  (read stops/agency/feed_info.txt)
 *                     make-sqlite  (gtfs.zip → sqlite3.gz)
 *   3. make-app-registry → outputs/feeds.json (schema-validated)
 *
 * Output layout (under `outputs/`):
 *   outputs/feeds.json
 *   outputs/feeds/<id>.gtfs.zip
 *   outputs/feeds/<id>.sqlite3.gz
 *
 * Publish: .github/workflows/daily.yml pushes outputs/ to binaries-staging.
 */

import { resolveFeeds } from './resolve-feeds.js';
import { fetchGtfs } from './fetch-gtfs.js';
import { deriveBbox } from './derive-bbox.js';
import { makeSqlite } from './make-sqlite.js';
import { makeAppRegistry } from './make-app-registry.js';
import { validate } from './validate.js';

async function main() {
  const t0 = Date.now();
  const feeds = await resolveFeeds();
  console.log(`[build-all] processing ${feeds.length} feed(s).`);

  const entries = [];
  for (const feed of feeds) {
    console.log(`\n=== ${feed.id} (${feed.source.type}) ===`);
    try {
      const gtfs = await fetchGtfs(feed);
      // Validate only what we BUILD; Transitous mirrors are already
      // validated upstream and re-validating is redundant churn.
      if (feed.source.type === 'build') {
        const { warnings } = validate(gtfs.localPath);
        for (const w of warnings) console.warn(`[validate] ${feed.id}: WARN ${w}`);
      }
      const meta = deriveBbox(gtfs.localPath);
      const sqlite = await makeSqlite(gtfs.localPath, feed.id);
      entries.push({ feed, gtfs, sqlite, ...meta });
      console.log(
        `[build-all] ${feed.id}: bbox=[${meta.bbox.minLat},${meta.bbox.minLon}]..[${meta.bbox.maxLat},${meta.bbox.maxLon}], gtfs=${(gtfs.sizeBytes / 1024).toFixed(1)}KB sqlite_gz=${sqlite ? (sqlite.sizeBytes / 1024).toFixed(1) + 'KB' : 'n/a'}`,
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

  console.log(`\n[build-all] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${entries.length}/${feeds.length} feed(s) ok.`);
}

main().catch((err) => {
  console.error('[build-all] fatal:', err);
  process.exit(1);
});
