/**
 * poller.ts — per-feed polling loop.
 *
 * Each feed has its own setInterval; independent errors don't affect
 * siblings. On each tick: fetch → decode → apply quirks → re-encode
 * → store. Errors are logged with `pino` but don't crash the loop.
 *
 * Why a single setInterval per feed (not a single setInterval that
 * iterates): a slow upstream for one feed shouldn't block the others
 * from being polled on their own schedule.
 */
import type { ResolvedFeed } from './feeds.js';
import { fetchVehiclePositions, UpstreamFetchError } from './upstream.js';
import { quirkFor } from './quirks/index.js';
import { putClean, reEncode } from './store.js';
import type { Logger } from 'pino';

export interface PollHandle {
  /** Stop polling and clear the interval. Idempotent. */
  stop(): void;
}

export function startPolling(
  feed: ResolvedFeed,
  intervalMs: number,
  upstreamTimeoutMs: number,
  log: Logger,
): PollHandle {
  const url = feed.realtime?.vehicle_positions;
  if (!url) {
    log.warn({ feedId: feed.id }, 'feed has no vehicle_positions URL; not polling');
    return { stop: () => {} };
  }

  const quirk = quirkFor(feed.id);

  const tick = async () => {
    try {
      const { feedMessage, fetchedAt } = await fetchVehiclePositions(url, upstreamTimeoutMs);
      const clean = quirk ? quirk(feedMessage, feed) : feedMessage;
      const { bytes, entityCount } = reEncode(clean);
      putClean({ feedId: feed.id, fetchedAt, appliedAt: new Date(), bytes, entityCount });
      log.debug({ feedId: feed.id, entityCount, fetchedAt }, 'polled');
    } catch (err) {
      if (err instanceof UpstreamFetchError) {
        log.warn({ feedId: feed.id, err: err.message, url }, 'upstream fetch failed');
      } else {
        log.error({ feedId: feed.id, err }, 'poll failed');
      }
    }
  };

  // First tick immediately so the store is warm before the first
  // request lands (avoids cold-start 502s for users).
  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return {
    stop: () => {
      clearInterval(handle);
    },
  };
}
