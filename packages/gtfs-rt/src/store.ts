/**
 * store.ts — in-memory cache of the latest clean (post-quirk)
 * FeedMessage per feed, plus the re-encoded protobuf bytes ready
 * to serve.
 *
 * The HTTP server reads from here, so per-request latency is just a
 * Map lookup + a buffer copy. The CF edge in front (Step 10) handles
 * the per-user polling fan-out; the Hetzner adapter only needs to
 * serve the few requests that miss the cache.
 *
 * For HA: the store is per-process. A multi-instance deployment would
 * need a shared cache (R2, Redis, etc.) — not in scope for Step 7.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
type FeedMessageType = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export interface CleanSnapshot {
  feedId: string;
  fetchedAt: Date;
  appliedAt: Date;
  bytes: Uint8Array;
  /** Number of entities (VehiclePosition etc.) in the clean message. */
  entityCount: number;
}

const STORE = new Map<string, CleanSnapshot>();

export function putClean(snap: CleanSnapshot): void {
  STORE.set(snap.feedId, snap);
}

export function getClean(feedId: string): CleanSnapshot | undefined {
  return STORE.get(feedId);
}

export function listClean(): CleanSnapshot[] {
  return Array.from(STORE.values());
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
