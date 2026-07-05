#!/usr/bin/env node
/**
 * cli.ts — daily orchestrator (single-publisher model).
 *
 *   1. resolve-feeds       — what are we publishing today?
 *   2. for each feed:
 *        acquireGtfs     — fetch URL OR invoke the feed's adapter's
 *                          ingestBuild (selected by feed.source.type
 *                          + source.publisher). Result: a content-
 *                          addressed .gtfs.zip staged under outputs/.
 *        validate        — remote only — light spec-shape check
 *        smoke           — remote only — per-feed contract check
 *        derive-bbox     — read stops/agency/feed_info.txt
 *        make-sqlite     — gtfs.zip → sqlite3.gz + per-feed StaticExtension
 *   3. make-app-registry → outputs/feeds.json (schema-validated, lists
 *                          both sqlite AND zip URLs)
 *
 * Output layout (under `outputs/`):
 *   outputs/feeds.json
 *   outputs/<id>-<hash12>.sqlite3.gz   — content-addressed URL
 *   outputs/<id>-<hash12>.gtfs.zip    — content-addressed URL
 *
 * Publish: .github/workflows/daily.yml uploads outputs/ to Cloudflare R2.
 *
 * Per-feed knowledge (StaticExtension + ingest pipeline) is owned by
 * `@n3ary/gtfs-adapter-<feed>` packages. This CLI orchestrates +
 * publishes; gtfs-adapters never touches R2. Adapter lookup is
 * driven entirely by `feedConfig.source.publisher` — adding a new
 * adapter-driven feed requires no changes to this file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFeeds } from './resolve-feeds.js';
import { fetchGtfs, OUTPUTS } from './fetch-gtfs.js';
import { deriveBbox } from './derive-bbox.js';
import { makeSqlite } from './make-sqlite.js';
import { makeAppRegistry } from './make-app-registry.js';
import { validate } from './validate.js';
import { smokeTestRemote } from './smoke-remote.js';
import { buildDryRunGtfsZip } from './dry-run-fixture.js';
import { UA } from './lib/http.js';
import type { StaticExtension } from './lib/extension.js';
import type { Feed, FeedEntry, FreshEntry, GtfsFile, ZipArtifact } from './lib/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/**
 * Resolve the adapter package name for a feed. Driven entirely by
 * the feed config's `source.publisher` — no per-feed lookup table
 * in the orchestrator.
 */
function adapterPublisher(feedConfig: Record<string, unknown> | null): string | null {
  const source = feedConfig?.source as { publisher?: unknown } | undefined;
  return typeof source?.publisher === 'string' ? source.publisher : null;
}

/**
 * Build a per-feed `StaticExtension` by dynamic-importing the
 * adapter package's `/static` subpath and calling its generic
 * `staticExtension(feedConfig)` factory. The factory name is
 * stable across adapters; the orchestrator never branches on
 * feed id.
 */
async function buildStaticExtension(feedConfig: Record<string, unknown> | null): Promise<StaticExtension | undefined> {
  const publisher = adapterPublisher(feedConfig);
  if (!publisher) return undefined;
  const mod = (await import(`${publisher}/static`)) as {
    staticExtension?: (cfg: Record<string, unknown>) => StaticExtension;
  };
  if (typeof mod.staticExtension !== 'function') {
    throw new Error(`${publisher}/static: must export a staticExtension(feedConfig) factory.`);
  }
  return mod.staticExtension(feedConfig ?? {});
}

/**
 * Read `feedConfig.secrets[]` (a list of process.env names the
 * adapter needs) and resolve each from the current environment.
 * Missing secrets throw with a clear message naming the feed + the
 * variable. Used by `acquireGtfs` to build the generic `secrets`
 * map that the adapter's `ingestBuild` consumes.
 */
function collectSecrets(feedId: string, feedConfig: Record<string, unknown> | null): Record<string, string | undefined> {
  const declared = (feedConfig?.secrets as unknown) ?? [];
  if (!Array.isArray(declared)) return {};
  const out: Record<string, string | undefined> = {};
  const missing: string[] = [];
  for (const name of declared) {
    if (typeof name !== 'string') continue;
    const value = process.env[name];
    if (!value) missing.push(name);
    out[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `acquireGtfs(${feedId}): missing secret(s) from feed config's secrets[]: ${missing.join(', ')}. ` +
      'Add them as GitHub Actions secrets on this repo, or set SKIP_ADAPTER_DRY_RUN=1 for a dry run.',
    );
  }
  return out;
}

/**
 * Adapter-driven GTFS zip production. Dynamic-imports the adapter's
 * `/ingest` subpath and calls its `ingestBuild({ outputDir, buildDate,
 * secrets })` entry. The orchestrator does not know what the adapter
 * does internally — it only passes through the staged outputDir,
 * the build clock, and the secrets map derived from the feed config.
 *
 * Returns the same shape as `fetchGtfs()` (localPath + sizeBytes +
 * hash) so downstream code doesn't branch.
 */
async function acquireGtfsAdapter(feedId: string, publisher: string, opts: {
  outputDir: string;
  buildDate: Date;
  secrets: Record<string, string | undefined>;
}): Promise<GtfsFile> {
  const mod = (await import(`${publisher}/ingest`)) as {
    ingestBuild?: (o: unknown) => Promise<{ zip: Buffer; sizeBytes: number }>;
  };
  if (typeof mod.ingestBuild !== 'function') {
    throw new Error(`${publisher}/ingest: must export an ingestBuild(opts) function.`);
  }
  const { zip, sizeBytes } = await mod.ingestBuild(opts);

  // Mirror fetchGtfs: stage under OUTPUTS and hash the staging file so
  // the same content-addressed path naming works for both code paths.
  mkdirSync(OUTPUTS, { recursive: true });
  const localPath = join(OUTPUTS, `${feedId}.gtfs.zip`);
  writeFileSync(localPath, zip);
  const hash = 'sha256-' + createHash('sha256').update(zip).digest('hex');
  return { localPath, sizeBytes, hash };
}

/**
 * Top-level dispatcher. Feeds with `source.type === 'adapter'` go
 * through the adapter package's `ingestBuild` (selected by the feed
 * config's `source.publisher`); everything else falls back to a
 * plain upstream URL fetch via `fetchGtfs`.
 *
 * Adapter-driven feeds also honour `SKIP_ADAPTER_DRY_RUN=1`: the
 * adapter call is short-circuited and a synthetic GTFS zip from
 * `./dry-run-fixture.js` is staged instead. Used by PR-validation on
 * forks without the feed's declared secrets — exercises the full
 * pipeline (deriveBbox, makeSqlite, feeds.json emit) with **zero
 * external HTTP**, which is the actual point of dry mode (catching
 * orchestrator-side regressions), not fail-open.
 */
async function acquireGtfs(feed: Feed, opts: { stageDir: string; feedConfig: Record<string, unknown> | null }): Promise<GtfsFile> {
  if (feed.source.type !== 'adapter') return fetchGtfs(feed);

  if (process.env.SKIP_ADAPTER_DRY_RUN === '1') {
    console.log(`[cli] ${feed.id}: SKIP_ADAPTER_DRY_RUN=1 — substituting synthetic GTFS zip, no external HTTP.`);
    const localPath = await buildDryRunGtfsZip(opts.stageDir, feed.id);
    const buf = readFileSync(localPath);
    const hash = 'sha256-' + createHash('sha256').update(buf).digest('hex');
    return { localPath, sizeBytes: buf.length, hash };
  }

  const publisher = adapterPublisher(opts.feedConfig);
  if (!publisher) {
    throw new Error(
      `acquireGtfs(${feed.id}): feed.source.type === 'adapter' but feedConfig.source.publisher is missing. ` +
      'Add a "publisher" field under the feed config\'s "source" object (e.g. "@n3ary/gtfs-adapter-<feed>").',
    );
  }
  const secrets = collectSecrets(feed.id, opts.feedConfig);

  return acquireGtfsAdapter(feed.id, publisher, {
    outputDir: opts.stageDir,
    buildDate: new Date(),
    secrets,
  });
}

function loadFeedConfig(feedId: string): Record<string, unknown> | null {
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
  files?: { sqlite_gz?: string; gtfs_zip?: string };
};

async function fetchPreviousRegistry(): Promise<Map<string, PrevEntry>> {
  try {
    const res = await fetch(PREV_REGISTRY_URL, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn(`[cli] previous registry: HTTP ${res.status} — full rebuild`);
      return new Map();
    }
    const reg = (await res.json()) as { feeds: PrevEntry[] };
    return new Map(reg.feeds.map((f) => [(f as { id: string }).id, f]));
  } catch (err) {
    console.warn(`[cli] previous registry: ${(err as Error).message} — full rebuild`);
    return new Map();
  }
}

/**
 * Final stage the zip gets written to (content-addressed). The format
 * is `outputs/<id>-<hash12>.gtfs.zip` mirroring the existing sqlite
 * naming, so the daily.yml R2 prune step can treat both symmetrically.
 */
function stageZipArtifact(gtfs: GtfsFile, feedId: string): ZipArtifact {
  const hash12 = gtfs.hash!.replace(/^sha256-/, '').slice(0, 12);
  const finalName = basenameContentAddressed(gtfs.localPath!, feedId, hash12);
  mkdirSync(OUTPUTS, { recursive: true });
  writeFileSync(finalName, readFileSync(gtfs.localPath!));
  // Clean up the non-content-addressed staging copy.
  try { rmSync(gtfs.localPath!); } catch { /* ignore */ }
  return {
    localPath: finalName,
    sizeBytes: gtfs.sizeBytes!,
    hash: gtfs.hash!,
  };
}

function basenameContentAddressed(originalPath: string, feedId: string, hash12: string): string {
  // Replace `feed-id.gtfs.zip` with `feed-id-<hash12>.gtfs.zip`.
  const dir = dirname(originalPath);
  return join(dir, `${feedId}-${hash12}.gtfs.zip`);
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
    //
    // Adapter-driven feeds (cluj) don't have an upstream URL we can HEAD
    // — fall back to FORCE_REBUILD-guarded unconditional rebuild.
    const prevEntry = prev.get(feed.id);
    const prevEtag = prevEntry?.source?.upstream_etag;
    const prevFile = prevEntry?.files?.sqlite_gz;
    const hashedFilename = typeof prevFile === 'string' &&
      new RegExp(`^${feed.id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}-[0-9a-f]{12}\\.sqlite3\\.gz$`).test(prevFile);
    const currentEtag = feed.source.upstream_url
      ? await fetchUpstreamEtag(feed.source.upstream_url)
      : null;
    const forceRebuild = !!process.env.FORCE_REBUILD;
    if (!forceRebuild && currentEtag && prevEtag && currentEtag === prevEtag && hashedFilename) {
      console.log(`[cli] ${feed.id}: upstream unchanged (ETag ${currentEtag}) — reusing previous build`);
      entries.push({ reused: true, prevEntry });
      reused++;
      continue;
    }
    if (forceRebuild && prevEtag && currentEtag === prevEtag) {
      console.log(`[cli] ${feed.id}: upstream unchanged (ETag ${currentEtag}) but FORCE_REBUILD set — rebuilding`);
    } else if (prevEtag && currentEtag === prevEtag && !hashedFilename) {
      console.log(`[cli] ${feed.id}: upstream unchanged but previous entry has legacy filename shape — rebuilding to migrate`);
    } else if (prevEtag && currentEtag) {
      console.log(`[cli] ${feed.id}: upstream changed (${prevEtag} → ${currentEtag}) — rebuilding`);
    } else if (prevEtag) {
      console.log(`[cli] ${feed.id}: no upstream ETag (adapter-driven); previous entry available — rebuilding`);
    }
    feed._currentEtag = currentEtag;

    try {
      const stageDir = join(OUTPUTS, 'stage', feed.id);
      const feedConfig = loadFeedConfig(feed.id);
      const gtfs = await acquireGtfs(feed, { stageDir, feedConfig });

      if (feed.source.type === 'remote' && gtfs.localPath && existsSync(gtfs.localPath)) {
        const { warnings } = validate(gtfs.localPath);
        for (const w of warnings) console.warn(`[validate] ${feed.id}: WARN ${w}`);
        const { checks } = smokeTestRemote(gtfs.localPath, feed._smoke);
        for (const c of checks) console.log(`[smoke] ${feed.id}: OK ${c}`);
      }

      const meta = deriveBbox(gtfs.localPath!);
      const staticExtension = await buildStaticExtension(feedConfig);
      const sqlite = await makeSqlite(gtfs.localPath!, feed.id, staticExtension);

      // Stage the GTFS zip into outputs/ as a content-addressed file
      // (mirroring how makeSqlite outputs the sqlite). The R2 publish
      // picks up both .sqlite3.gz and .gtfs.zip files together.
      const zip = gtfs.hash && gtfs.sizeBytes != null
        ? stageZipArtifact(gtfs, feed.id)
        : null;

      const fresh: FreshEntry = {
        feed, gtfs, zip, sqlite,
        upstreamEtag: feed._currentEtag ?? null,
        ...meta,
      };
      entries.push(fresh);
      console.log(
        `[cli] ${feed.id}: bbox=[${meta.bbox.minLat},${meta.bbox.minLon}]..[${meta.bbox.maxLat},${meta.bbox.maxLon}], ` +
        `sqlite_gz=${sqlite ? (sqlite.sizeBytes / 1024).toFixed(1) + 'KB' : 'n/a'}` +
        `, zip=${zip ? (zip.sizeBytes / 1024).toFixed(1) + 'KB' : 'n/a'}`,
      );

      // Clean up the stage dir; outputs/ retains only the content-
      // addressed artifacts we actually publish.
      if (existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
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
}

main().catch((err) => {
  console.error('[cli] fatal:', err);
  process.exit(1);
});
