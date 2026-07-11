/**
 * poller.ts — per-feed polling loop.
 *
 * Each feed has one served URL (`realtime.upstream_vehicle_positions`)
 * and zero or more extras (`realtime.extra_vehicle_positions[]`). The
 * served URL is what `/rt/<feed>/vehicle_positions` exposes; the
 * extras are polled + stored for future reconciliation but not yet
 * served. Each URL has its own setInterval so a slow upstream for
 * one URL doesn't block the others.
 *
 * The "primary vs extra" split lives in the plan shape, not as a
 * role tag on the URL: the plan is `{ primary, extras }`, and the
 * tick derives its role from `url === plan.primary`. The `role`
 * string we pass to `putSource` is a stored attribute on the
 * per-URL source record (for log filtering and future
 * reconciliation), not a control-flow tag.
 *
 * On every tick: fetch -> decode -> apply Quirk(msg, ctx) ->
 * validate against libs/spec/schema's FeedMessageSchema -> re-encode
 * -> store.
 *
 * Quirk application is per-URL: ctx tells the adapter which URL
 * produced the bytes so future per-URL dispatch is one `if
 * (ctx.url === ...)` line in the adapter, not a config change here.
 *
 * `realtime.upstream_vehicle_positions` is REQUIRED. A feed without
 * it is treated as "no realtime" (skipped). The previous fallback to
 * `realtime.vehicle_positions` was removed when the upstream /
 * consumer split landed because the consumer slot is the proxy URL
 * (`gtfs-rt.n3ary.com/rt/<id>/vehicle_positions`) -- polling that
 * here would make the server poll itself, which is the circular
 * dependency the split exists to avoid.
 *
 * Errors are logged via pino but don't crash the loop.
 */
import type { ResolvedFeed } from './feeds.js';
import { fetchVehiclePositions, UpstreamFetchError } from './upstream.js';
import { loadAdapter, type QuirkContext } from './adapter.js';
import { FeedMessageSchema } from '@n3ary/gtfs-spec/schema';
import { putClean, putSource, reEncode } from './store.js';
import type { Logger } from 'pino';

export interface PollHandle {
  /** Stop polling and clear every interval. Idempotent. */
  stop(): void;
}

/** Per-feed poll plan. The served URL is `primary`; everything
 *  in `extras` is polled + stored but not exposed via the
 *  public `/rt/<feed>/vehicle_positions` endpoint. */
interface PollPlan {
  primary: string;
  extras: string[];
}

function buildPollPlan(feed: ResolvedFeed): PollPlan | null {
  const rt = feed.realtime;
  if (!rt?.upstream_vehicle_positions) return null;
  return {
    primary: rt.upstream_vehicle_positions,
    extras: rt.extra_vehicle_positions ?? [],
  };
}

export function startPolling(
  feed: ResolvedFeed,
  intervalMs: number,
  upstreamTimeoutMs: number,
  log: Logger,
): PollHandle {
  const plan = buildPollPlan(feed);
  if (!plan) {
    log.warn(
      { feedId: feed.id },
      'feed has no realtime.upstream_vehicle_positions; not polling',
    );
    return { stop: () => {} };
  }

  log.info(
    { feedId: feed.id, primary: plan.primary, extras: plan.extras },
    'poll plan',
  );

  const handles: ReturnType<typeof setInterval>[] = [];
  for (const url of [plan.primary, ...plan.extras]) {
    const isPrimary = url === plan.primary;
    const tick = makeTick(feed, url, isPrimary, upstreamTimeoutMs, log);
    // First tick immediately so the store is warm before the first
    // request lands (avoids cold-start 502s for users).
    void tick();
    handles.push(setInterval(() => void tick(), intervalMs));
  }

  return {
    stop: () => {
      for (const h of handles) clearInterval(h);
    },
  };
}

function makeTick(
  feed: ResolvedFeed,
  url: string,
  isPrimary: boolean,
  upstreamTimeoutMs: number,
  log: Logger,
): () => Promise<void> {
  // Role is a stored attribute on the per-URL source record, not
  // a control-flow tag on the URL. Derived once at tick-construction
  // time from `isPrimary`.
  const role: 'primary' | 'extra' = isPrimary ? 'primary' : 'extra';
  return async () => {
    try {
      const { feedMessage, fetchedAt } = await fetchVehiclePositions(url, upstreamTimeoutMs);
      const quirk = await loadAdapter(feed);
      const ctx: QuirkContext = {
        url,
        feed: { id: feed.id, name: feed.name, country: feed.country },
      };
      const cleaned = quirk ? quirk(feedMessage, ctx) : feedMessage;

      // Spec validation gates malformed output before we re-encode +
      // serve. parse() throws ZodError on failure; we log and skip.
      const parseResult = FeedMessageSchema.safeParse(cleaned);
      if (!parseResult.success) {
        log.warn(
          { feedId: feed.id, url, role, issues: parseResult.error.issues.slice(0, 5) },
          'adapter output failed FeedMessageSchema; dropping snapshot',
        );
        return;
      }

      // The parser returns the schema-validated shape (no protobufjs
      // prototype methods); reEncode wants the real protobufjs
      // message type. Cast via unknown -- safe because we've just
      // confirmed the shape matches the schema we wrote.
      const { bytes, entityCount } = reEncode(parseResult.data as unknown as Parameters<typeof reEncode>[0]);
      const appliedAt = new Date();
      putSource({ feedId: feed.id, url, role, fetchedAt, appliedAt, bytes, entityCount });
      // Only the primary URL is exposed via /rt/<feed>/vehicle_positions
      // until reconciliation lands. Extras live in putSource only.
      if (isPrimary) {
        putClean({ feedId: feed.id, fetchedAt, appliedAt, bytes, entityCount });
      }
      log.debug({ feedId: feed.id, url, role, entityCount, fetchedAt }, 'polled');
    } catch (err) {
      if (err instanceof UpstreamFetchError) {
        log.warn({ feedId: feed.id, url, role, err: err.message }, 'upstream fetch failed');
      } else {
        log.error({ feedId: feed.id, url, role, err }, 'poll failed');
      }
    }
  };
}
