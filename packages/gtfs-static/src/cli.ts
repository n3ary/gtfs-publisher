#!/usr/bin/env node
/**
 * cli.ts — daily orchestrator.
 *
 *   1. resolve-feeds       — what are we publishing today?
 *   2. for each feed: fetch-gtfs   (download from upstream URL)
 *                     validate     (remote only — light spec-shape check)
 *                     smoke        (remote only — per-feed contract check)
 *                     derive-bbox  (read stops/agency/feed_info.txt)
 *                     make-sqlite  (gtfs.zip → sqlite3.gz) + per-feed StaticExtension
 *   3. make-app-registry → outputs/feeds.json (schema-validated)
 *
 * Output layout (under `outputs/`):
 *   outputs/feeds.json
 *   outputs/<id>-<hash12>.sqlite3.gz  — content-addressed URL
 *
 * Publish: .github/workflows/daily.yml uploads outputs/ to Cloudflare R2.
 *
 * Per-feed `StaticExtension` knowledge comes from the matching
 * `@n3ary/gtfs-adapter-<feed>` package (e.g. cluj-napoca → the static
 * pipeline color fixup + the `_neary_config` rows from
 * `feeds/<id>/config.json`'s `timing` block). See
 * `n3ary/gtfs-adapters/adapters/<feed>/src/static/`. The generic
 * pipeline owns no per-feed defaults.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFeeds } from './resolve-feeds.js';
import { fetchGtfs, OUTPUTS } from './fetch-gtfs.js';
import { deriveBbox } from './derive-bbox.js';
import { makeSqlite } from './make-sqlite.js';
import { makeAppRegistry } from './make-app-registry.js';
import { validate } from './validate.js';
import { smokeTestRemote } from './smoke-remote.js';
import { UA } from './lib/http.js';
import type { StaticExtension } from './lib/extension.js';
import type { Feed, FeedEntry, FreshEntry } from './lib/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// adapter lookup — explicit, feed-id-keyed. Maps each known feed to a
// function that constructs its `StaticExtension` from the feed's
// `feeds/<id>/config.json` (loaded by `loadFeedConfig`). Each adapter
// is imported lazily so the import cost is paid only for feeds that
// use it (currently just cluj). Future feeds plug in here, or move to
// a manifest-driven registry once gtfs-adapters exposes one.
async function buildStaticExtension(feedId: string, feedConfig: Record<string, unknown> | null): Promise<StaticExtension | undefined> {
  if (!feedConfig) return undefined;
  switch (feedId) {
    case 'cluj-napoca': {
      const mod = await import('@n3ary/gtfs-adapter-cluj-napoca/static');
      return mod.clujStaticExtension(feedConfig);
    }
    // Future per-feed adapters wire in here. Each adapter's package
    // declares its own `staticExtension(feedConfig)` shape; the
    // generic pipeline just passes whatever the function returns.
    default:
      return undefined;
  }
}

function loadFeedConfig(feedId: string): Record<string, unknown> | null {
  // The feed override directory (feeds/<id>/config.json) is
  // the per-feed manifest. The cluj adapter's `clujStaticExtension`
  // reads its `timing` block. Other feeds may have other keys that
  // their adapters read; both sides know about the same file because
  // the file is committed alongside the pipeline that uses it.
  const configPath = join(ROOT, 'feeds', feedId, 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[cli] ${feedId}: failed to parse ${configPath} — ${(err as Error).message}`);
    return null;
  }
}

const DEFAULT_PUBLIC_BASE_URL = 'https://gtfs.n3ary.com';
const PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL ?? DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
const PREV_REGISTRY_URL = `${PUBLIC_BASE_URL}/feeds.json`;

type PrevEntry = {
  source?: { upstream_etag?: string };
  files?: { sqlite_gz?: string };
};

async function fetchPreviousRegistry(): Promise<Map<string, PrevEntry>> {
  try {
    const res = await fetch(PREV_REGISTRY_URL, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn(`[cli] previous registry: HTTP ${res.status} — full rebuild`);
      return new Map();
    }
    const reg = await res.json() as { feeds: PrevEntry[] };
    return new Map(reg.feeds.map((f) => [(f as { id: string }).id, f]));
  } catch (err) {
    console.warn(`[cli] previous registry: ${(err as Error).message} — full rebuild`);
    return new Map();
  }
}

async function fetchUpstreamEtag(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    return res.headers.get('etag');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const feeds = await resolveFeeds();
  const prev = await fetchPreviousRegistry();
  console.log(`[cli] processing ${feeds.length} feed(s); previous registry has ${prev.size}`);

  const entries: FeedEntry[] = [];
  let reused = 0;

  for (const feed of feeds) {
    console.log(`\n=== ${feed.id} (${feed.source.type}) ===`);

    // Skip-on-unchanged: if upstream ETag is unchanged AND we already
    // shipped a hash-versioned sqlite_gz for this feed, pass the previous
    // entry through. Bypassed when FORCE_REBUILD is set.
    const prevEntry = prev.get(feed.id);
    const prevEtag = prevEntry?.source?.upstream_etag;
    const prevFile = prevEntry?.files?.sqlite_gz;
    const hashedFilename = typeof prevFile === 'string' &&
      new RegExp(`^${feed.id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-[0-9a-f]{12}\\.sqlite3\\.gz$`).test(prevFile);
    const currentEtag = await fetchUpstreamEtag(feed.source.upstream_url!);
    const forceRebuild = !!process.env.FORCE_REBUILD;
    if (!forceRebuild && prevEtag && currentEtag === prevEtag && hashedFilename) {
      console.log(`[cli] ${feed.id}: upstream unchanged (ETag ${currentEtag}) — reusing previous build`);
      entries.push({ reused: true, prevEntry });
      reused++;
      continue;
    }
    if (forceRebuild && prevEtag && currentEtag === prevEtag) {
      console.log(`[cli] ${feed.id}: upstream unchanged (ETag ${currentEtag}) but FORCE_REBUILD set — rebuilding`);
    } else if (prevEtag && currentEtag === prevEtag && !hashedFilename) {
      console.log(`[cli] ${feed.id}: upstream unchanged but previous entry has legacy filename shape — rebuilding to migrate`);
    } else if (prevEtag) {
      console.log(`[cli] ${feed.id}: upstream changed (${prevEtag} → ${currentEtag ?? 'null'}) — rebuilding`);
    }
    feed._currentEtag = currentEtag;

    try {
      const gtfs = await fetchGtfs(feed);

      if (feed.source.type === 'remote') {
        const { warnings } = validate(gtfs.localPath!);
        for (const w of warnings) console.warn(`[validate] ${feed.id}: WARN ${w}`);
        const { checks } = smokeTestRemote(gtfs.localPath!, feed._smoke);
        for (const c of checks) console.log(`[smoke] ${feed.id}: OK ${c}`);
      }

      const meta = deriveBbox(gtfs.localPath!);
      const feedConfig = loadFeedConfig(feed.id);
      const staticExtension = await buildStaticExtension(feed.id, feedConfig);
      const sqlite = await makeSqlite(gtfs.localPath!, feed.id, staticExtension);

      // The raw .gtfs.zip isn't republished — consumers fetch it from the
      // upstream URL recorded in source.upstream_url.
      if (gtfs.localPath && existsSync(gtfs.localPath)) {
        unlinkSync(gtfs.localPath);
        gtfs.localPath = null;
        gtfs.sizeBytes = null;
        gtfs.hash = null;
      }

      const fresh: FreshEntry = {
        feed, gtfs, sqlite,
        upstreamEtag: feed._currentEtag ?? null,
        ...meta,
      };
      entries.push(fresh);
      console.log(
        `[cli] ${feed.id}: bbox=[${meta.bbox.minLat},${meta.bbox.minLon}]..[${meta.bbox.maxLat},${meta.bbox.maxLon}], sqlite_gz=${sqlite ? (sqlite.sizeBytes / 1024).toFixed(1) + 'KB' : 'n/a'}`,
      );
    } catch (err) {
      console.error(`[cli] ${feed.id}: FAILED — ${(err as Error).message}`);
      if (process.env.STRICT === 'true') throw err;
    }
  }

  if (entries.length === 0) {
    throw new Error('no feeds built successfully');
  }
  makeAppRegistry(entries);

  console.log(
    `\n[cli] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${entries.length - reused} fresh, ${reused} reused, ${entries.length}/${feeds.length} total`,
  );

  // OUTPUTS is referenced to ensure the import is preserved (avoid
  // tree-shaking by tsc in case future code uses it).
  void OUTPUTS;
  void fetchPreviousRegistry;
  void fetchUpstreamEtag;
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});