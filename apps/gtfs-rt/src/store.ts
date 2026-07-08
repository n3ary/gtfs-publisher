/**
 * store.ts — in-memory cache of clean (post-Quirk, schema-validated)
 * FeedMessage bytes, ready to serve.
 *
 * Two parallel views:
 *   - putClean / getClean(feedId): the per-feed PRIMARY snapshot,
 *     served by /rt/<feed>/vehicle_positions. This is what clients
 *     see today.
 *   - putSource: every URL's snapshot (primary + extras), keyed by
 *     (feedId, url). Used internally by the reconciler when extras
 *     land. Extras are stored but not yet served.
 *
 * The HTTP server reads from putClean, so per-request latency is a
 * single Map lookup + a buffer copy. The CF edge in front (Step 10)
 * handles the per-user polling fan-out; the Hetzner pod only serves
 * the few requests that miss the cache.
 *
 * For HA: the store is per-process. A multi-instance deployment
 * would need a shared cache (R2, Redis, etc.) -- not in scope for
 * Step 7.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
type FeedMessageType = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export type SnapshotRole = 'primary' | 'extra';

export interface CleanSnapshot {
  feedId: string;
  fetchedAt: Date;
  appliedAt: Date;
  bytes: Uint8Array;
  /** Number of entities (VehiclePosition etc.) in the clean message. */
  entityCount: number;
}

export interface SourceSnapshot extends CleanSnapshot {
  url: string;
  role: SnapshotRole;
}

const PRIMARY = new Map<string, CleanSnapshot>();
const BY_SOURCE = new Map<string, SourceSnapshot>();

/** Per-feed primary snapshot (what /rt/<feed>/vehicle_positions serves). */
export function putClean(snap: CleanSnapshot): void {
  PRIMARY.set(snap.feedId, snap);
}

/** Per-source snapshot (every URL we polled, primary + extras). */
export function putSource(snap: SourceSnapshot): void {
  BY_SOURCE.set(`${snap.feedId}::${snap.url}`, snap);
}

export function getClean(feedId: string): CleanSnapshot | undefined {
  return PRIMARY.get(feedId);
}

export function getSource(feedId: string, url: string): SourceSnapshot | undefined {
  return BY_SOURCE.get(`${feedId}::${url}`);
}

/** Per-source snapshots for a feed, ordered primary first then extras
 *  in declaration order. */
export function listSourcesForFeed(feedId: string): SourceSnapshot[] {
  return [...BY_SOURCE.values()].filter((s) => s.feedId === feedId);
}

export function listClean(): CleanSnapshot[] {
  return [...PRIMARY.values()];
}

export function reEncode(message: FeedMessageType): {
  bytes: Uint8Array;
  entityCount: number;
} {
  return {
    bytes: FeedMessage.encode(message).finish(),
    entityCount: message.entity.length,
  };
}
