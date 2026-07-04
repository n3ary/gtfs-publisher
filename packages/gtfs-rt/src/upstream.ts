/**
 * upstream.ts — fetch a GTFS-RT vehicle_positions URL and decode the
 * raw protobuf bytes into a structured FeedMessage.
 *
 * The decode uses the canonical Google protobuf schema (gtfs-realtime-
 * bindings) so the result is always spec-shaped; per-feed quirks
 * (recovering direction_id, start_time, etc.) run on this decoded
 * object in the poller, not in the decode step.
 *
 * Why we don't re-encode on every fetch: the poller only needs the
 * decoded object to apply quirks. The quirk output is re-encoded once
 * before storing in the in-memory store, then served as bytes from
 * there. See poller.ts.
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
type FeedMessageType = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export interface UpstreamFetchResult {
  /** Decoded FeedMessage, ready for quirk application. */
  feedMessage: FeedMessageType;
  /** Wall-clock timestamp when the upstream fetch completed. */
  fetchedAt: Date;
  /** Raw bytes (cached for re-encoding in poller). */
  rawBytes: Uint8Array;
}

export class UpstreamFetchError extends Error {
  override readonly cause?: unknown;
  constructor(
    message: string,
    public readonly url: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'UpstreamFetchError';
    if (cause !== undefined) this.cause = cause;
  }
}

export async function fetchVehiclePositions(
  url: string,
  timeoutMs: number,
): Promise<UpstreamFetchResult> {
  if (!/^https?:\/\//.test(url)) {
    throw new UpstreamFetchError(`refusing non-http(s) upstream URL: ${url}`, url);
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) {
      throw new UpstreamFetchError(`upstream ${res.status} ${res.statusText}`, url);
    }
    const rawBytes = new Uint8Array(await res.arrayBuffer());
    if (rawBytes.length === 0) {
      throw new UpstreamFetchError('upstream returned empty body', url);
    }
    const feedMessage = FeedMessage.decode(rawBytes) as FeedMessageType;
    return { feedMessage, fetchedAt: new Date(), rawBytes };
  } catch (err) {
    if (err instanceof UpstreamFetchError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new UpstreamFetchError(`upstream fetch exceeded ${timeoutMs}ms`, url, err);
    }
    throw new UpstreamFetchError(`upstream fetch failed: ${(err as Error).message}`, url, err);
  } finally {
    clearTimeout(timer);
  }
}
