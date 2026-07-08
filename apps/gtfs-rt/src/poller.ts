/**
 * poller.ts — per-feed polling loop.
 *
 * Each feed has one primary URL (`realtime.vehicle_positions`) and
 * zero or more extras (`realtime.extra_vehicle_positions[]`).
 * Each URL has its own setInterval so a slow upstream for one URL
 * doesn't block the others.
 *
 * On every tick: fetch -> decode -> apply Quirk(msg, ctx) ->
 * validate against libs/spec/schema's FeedMessageSchema -> re-encode
 * -> store.
 *
 * Quirk application is per-URL: ctx tells the adapter which URL
 * produced the bytes so future per-URL dispatch is one `if
 * (ctx.url === ...)` line in the adapter, not a config change here.
 *
 * For now (no reconciliation): the HTTP server serves the primary
 * snapshot only. Extras are stored in the per-URL sub-store; a
 * follow-up PR surfaces the reconciliation UI.
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

interface UrlPlan {
  /** 'primary' | 'extra' -- purely for logging / observability. */
  role: 'primary' | 'extra';
  url: string;
}

function planUrls(feed: ResolvedFeed): UrlPlan[] {
  const rt = feed.realtime;
  if (!rt) return [];
  const plan: UrlPlan[] = [];
  if (rt.vehicle_positions) plan.push({ role: 'primary', url: rt.vehicle_positions });
  for (const url of rt.extra_vehicle_positions ?? []) {
    plan.push({ role: 'extra', url });
  }
  return plan;
}

export function startPolling(
  feed: ResolvedFeed,
  intervalMs: number,
  upstreamTimeoutMs: number,
  log: Logger,
): PollHandle {
  const plan = planUrls(feed);
  if (plan.length === 0) {
    log.warn({ feedId: feed.id }, 'feed has no vehicle_positions URLs; not polling');
    return { stop: () => {} };
  }

  log.info(
    { feedId: feed.id, primary: plan.find((p) => p.role === 'primary')?.url, extras: plan.filter((p) => p.role === 'extra').map((p) => p.url) },
    'poll plan',
  );

  const handles: ReturnType<typeof setInterval>[] = [];
  for (const item of plan) {
    const tick = makeTick(feed, item, upstreamTimeoutMs, log);
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
  item: UrlPlan,
  upstreamTimeoutMs: number,
  log: Logger,
): () => Promise<void> {
  return async () => {
    try {
      const { feedMessage, fetchedAt } = await fetchVehiclePositions(item.url, upstreamTimeoutMs);
      const quirk = await loadAdapter(feed);
      const ctx: QuirkContext = {
        url: item.url,
        feed: { id: feed.id, name: feed.name, country: feed.country },
      };
      const cleaned = quirk ? quirk(feedMessage, ctx) : feedMessage;

      // Spec validation gates malformed output before we re-encode +
      // serve. parse() throws ZodError on failure; we log and skip.
      const parseResult = FeedMessageSchema.safeParse(cleaned);
      if (!parseResult.success) {
        log.warn(
          { feedId: feed.id, url: item.url, role: item.role, issues: parseResult.error.issues.slice(0, 5) },
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
      putSource({ feedId: feed.id, url: item.url, role: item.role, fetchedAt, appliedAt, bytes, entityCount });
      // Only the primary URL is exposed via /rt/<feed>/vehicle_positions
      // until reconciliation lands. Extras live in putSource only.
      if (item.role === 'primary') {
        putClean({ feedId: feed.id, fetchedAt, appliedAt, bytes, entityCount });
      }
      log.debug({ feedId: feed.id, url: item.url, role: item.role, entityCount, fetchedAt }, 'polled');
    } catch (err) {
      if (err instanceof UpstreamFetchError) {
        log.warn({ feedId: feed.id, url: item.url, role: item.role, err: err.message }, 'upstream fetch failed');
      } else {
        log.error({ feedId: feed.id, url: item.url, role: item.role, err }, 'poll failed');
      }
    }
  };
}
