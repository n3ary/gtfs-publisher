/**
 * adapter.ts — per-feed adapter loader.
 *
 * For feeds whose `source.type === "adapter"`, this dynamic-imports
 * `${source.publisher}/rt` and looks up the per-feed Quirk function
 * inside it. For other feeds (`transitous`, `mobility-database`,
 * `remote`) the upstream is well-formed and no quirk is loaded —
 * the proxy serves the bytes verbatim.
 *
 * No per-feed config file. The adapter name is already in feeds.json
 * as `feed.source.publisher`, declared once in
 * `<repo-root>/feeds/<id>/config.json` and copied into feeds.json by
 * the static pipeline. Single source of truth, no drift.
 *
 * The Quirk function shape is `(msg, ctx) => msg`. Adapters that
 * still export the legacy 1-arg `(msg) => msg` shape (notably the
 * currently-published @n3ary/gtfs-adapter-cluj-napoca@0.3.5) are
 * wrapped to accept and ignore ctx. TEMP: remove the wrapper once
 * the cluj adapter publishes 2-arg shape (n3ary/gtfs-adapters
 * follow-up PR).
 */
import type { ResolvedFeed } from './feeds.js';

/** Subset of ResolvedFeed that an adapter's Quirk is allowed to read.
 *  Pure-data fields only -- never a writeable handle. */
export interface QuirkFeedView {
  id: string;
  name: string;
  country: string;
}

export interface QuirkContext {
  /** The upstream URL that produced this FeedMessage. Adapters use
   *  this for per-URL dispatch if one feed's adapter handles multiple
   *  URL flavours (primary + extras). */
  url: string;
  /** Read-only feed metadata (subset of ResolvedFeed). */
  feed: Readonly<QuirkFeedView>;
}

/** Loose type because the decoded FeedMessage is an opaque protobufjs
 *  object -- we don't tightly couple the rt app to the binary schema
 *  it just round-trips. The minimal shape validation happens via
 *  @n3ary/gtfs-spec/schema's FeedMessageSchema, separately. */
export type FeedMessageLike = unknown;

export type Quirk = (msg: FeedMessageLike, ctx: QuirkContext) => FeedMessageLike;

/** Tri-state cache: undefined = not loaded, function = loaded quirk,
 *  null = loaded but no quirk (pass-through). */
const cache = new Map<string, Quirk | null>();

export async function loadAdapter(feed: ResolvedFeed): Promise<Quirk | null> {
  const hit = cache.get(feed.id);
  if (hit !== undefined) return hit;

  if (feed.source?.type !== 'adapter' || !feed.source.publisher) {
    cache.set(feed.id, null);
    return null;
  }

  try {
    const mod: any = await import(`${feed.source.publisher}/rt`);
    const fn = pickQuirkFn(mod);
    if (typeof fn !== 'function') {
      cache.set(feed.id, null);
      return null;
    }
    // Bridge: legacy (msg)=>msg signatures get the 2-arg wrapper.
    // TEMP; see file header.
    const quirk: Quirk = (msg, ctx) =>
      fn.length >= 2 ? fn(msg, ctx) : fn(msg);
    cache.set(feed.id, quirk);
    return quirk;
  } catch (err) {
    // Adapter package not installed / network failure / etc.
    // Don't crash the feed; serve pass-through and log upstream.
    cache.set(feed.id, null);
    return null;
  }
}

/** Look up the per-feed Quirk function on a dynamic-imported adapter
 *  module. Order: clujQuirk (cluj), quirk (generic), applyTo (verb),
 *  default (fallback). Discovery, not a contract -- adapters are
 *  free to rename as long as one of these names is exported. */
function pickQuirkFn(mod: any): unknown {
  return mod.clujQuirk ?? mod.quirk ?? mod.applyTo ?? mod.default;
}

/** Drops the in-memory adapter cache. Tests use it between cases so
 *  mocks don't leak. */
export function clearAdapterCache(): void {
  cache.clear();
}

/** Synchronous list of feed IDs that have an adapter resolution
 *  attempted. After a successful `loadAdapter`, this exposes which
 *  feeds went through the dynamic-import path (vs the always-null
 *  transitous/mobility-database path). */
export function adaptersWithQuirk(): string[] {
  return [...cache.entries()]
    .filter(([, v]) => v !== null)
    .map(([k]) => k)
    .sort();
}
