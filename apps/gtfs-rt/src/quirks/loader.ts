/**
 * Loader for per-feed quirks.
 *
 * Each quirk lives in a separate `@n3ary/gtfs-adapter-*` package; this
 * layer has no feed-named code. Per-feed config lives at
 * `<configDir>/<feedId>/config.json` and declares which adapter
 * package to load (subpath `/rt`).
 *
 * No `configDir/<feedId>/config.json` => no quirk loaded for that
 * feed => pass-through (upstream bytes flow to the store unmodified).
 * Adding a quirk for a new feed is a config file + the adapter package,
 * not a code change to the proxy.
 *
 * Caching: per-feedId, lazy on first poll tick. The loaded quirk
 * function is pure (`FeedMessage -> FeedMessage`), so the same
 * instance reused across ticks is safe.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Quirk } from './types.js';

/** Dir name relative to the rt app's working directory. The
 *  container's WORKDIR is `apps/gtfs-rt`, which keeps the path stable
 *  between `pnpm dev` (cwd = `apps/gtfs-rt`) and the deployed binary. */
export const DEFAULT_FEEDS_CONFIG_DIR = 'feeds';

export interface FeedConfig {
  /** Adapter package name; subpath is conventional `/rt`. */
  adapter?: string;
}

/** Returns the runtime config-dir (overridable via `setConfigDir`).
 *  Kept module-level because `loadQuirk` and `quirkFeedIds` are
 *  called from many places; tests flip it via `setConfigDir` then
 *  restore with `resetConfigDir`. */
let activeConfigDir: string = join(process.cwd(), DEFAULT_FEEDS_CONFIG_DIR);

export function setConfigDir(dir: string): void {
  activeConfigDir = dir;
}
export function resetConfigDir(): void {
  activeConfigDir = join(process.cwd(), DEFAULT_FEEDS_CONFIG_DIR);
}
export function getConfigDir(): string {
  return activeConfigDir;
}

/** Tri-state cache value:
 *   `undefined`             -- not loaded yet for this feedId
 *   `Quirk | null`          -- loaded; `null` means "no adapter
 *                              configured, pass through"
 * The wrapper object below distinguishes the three cases; a plain
 * Map<feedId, Quirk | null> would conflate "not yet" with "no quirk".
 */
const cache = new Map<string, { quirk: Quirk | null }>();

/** Returns the quirk for a feed, or `null` to mean "no quirk
 *  configured, pass through". Loaded lazily on first call; subsequent
 *  calls reuse the cached instance. */
export async function loadQuirk(feedId: string): Promise<Quirk | null> {
  const hit = cache.get(feedId);
  if (hit) return hit.quirk;

  let cfg: FeedConfig | null = null;
  try {
    cfg = await readFeedConfig(feedId);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      // Config file present but unreadable / malformed JSON is a real
      // bug; surface it instead of swallowing into pass-through.
      throw err;
    }
    // ENOENT == no per-feed config; pass-through.
  }

  if (!cfg?.adapter) {
    cache.set(feedId, { quirk: null });
    return null;
  }

  // Dynamic import: the adapter package name comes from config.json
  // and is intentionally feed-agnostic in this layer. We type the
  // module as `any` because we can't statically know the export shape
  // across adapters; `pickQuirk` recovers the function at runtime.
  const mod: any = await import(`${cfg.adapter}/rt`);
  const fn = pickQuirk(mod);
  if (typeof fn !== 'function') {
    throw new Error(
      `adapter "${cfg.adapter}/rt" exports no Quirk function (looked for clujQuirk, quirk, applyTo, default)`,
    );
  }
  const quirk: Quirk = (msg, _feed) => fn(msg);
  cache.set(feedId, { quirk });
  return quirk;
}

/** Search the adapter module's exports for a function that looks like
 *  a Quirk. Order: clujQuirk (cluj), quirk (generic), applyTo (verb),
 *  default (fallback). Discovery, not a contract — adapters are free
 *  to rename as long as one of these names is exported. */
function pickQuirk(mod: any): unknown {
  return mod.clujQuirk ?? mod.quirk ?? mod.applyTo ?? mod.default;
}

/** Drop the in-memory quirk cache. Tests use it between cases so a
 *  real `feeds/<id>/config.json` under the working dir doesn't leak
 *  state. */
export function clearQuirkCache(): void {
  cache.clear();
}

/** Lists the feed IDs that have a configured per-feed quirk (i.e.
 *  `feeds/<id>/config.json` exists). Used by `/healthz` and the test
 *  for that endpoint. Synchronous because it's a directory scan, not
 *  I/O. */
export function quirkFeedIds(): string[] {
  const dir = activeConfigDir;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const ids: string[] = [];
  for (const entry of entries) {
    // `<id>/config.json` is the only shape we recognise; any other
    // file under the config dir is ignored.
    if (existsSync(join(dir, entry, 'config.json'))) {
      ids.push(entry);
    }
  }
  return ids.sort();
}

async function readFeedConfig(feedId: string): Promise<FeedConfig | null> {
  const path = join(activeConfigDir, feedId, 'config.json');
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as FeedConfig;
}
