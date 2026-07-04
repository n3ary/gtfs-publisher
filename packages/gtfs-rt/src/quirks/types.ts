/**
 * Quirk interface. Each per-feed quirk takes a freshly-decoded
 * FeedMessage (and the feed metadata for context) and returns a
 * possibly-modified copy. Pure function — no side effects, no I/O.
 *
 * The poll-and-store flow is:
 *   1. fetch → decode (upstream.ts)
 *   2. apply quirks (here)
 *   3. re-encode → store in memory (poller.ts)
 *
 * Adding a new quirk for a new feed is a single file under
 * src/quirks/<feed>.ts plus a one-line import in src/quirks/index.ts.
 */
import type GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { ResolvedFeed } from '../feeds.js';

type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

export type Quirk = (feedMessage: FeedMessage, feed: ResolvedFeed) => FeedMessage;
