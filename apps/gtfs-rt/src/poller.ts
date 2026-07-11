/**
 * poller.ts — per-feed polling loop.
 *
 * Each feed has one served URL (`realtime.upstream_vehicle_positions`)
 * and zero or more extras (`realtime.extra_vehicle_positions[]`).
 * The served URL is what `/rt/<feed>/vehicle_positions` exposes
 * AFTER reconciliation: the reconciler (apps/gtfs-rt/src/reconcile.ts)
 * merges N source snapshots into one deduplicated, freshest-wins
 * FeedMessage and writes the result to `putClean`. The extras are
 * polled + stored for that merge. Each URL has its own setInterval
 * so a slow upstream for one URL doesn't block the others.
 *
 * The "primary vs extra" split lives in the plan shape, not as a
 * role tag on the URL: the plan is `{ primary, extras }`, and the
 * tick derives its role from `url === plan.primary`. The `role`
 * string we pass to `putSource` is a stored attribute on the
 * per-URL source record (for log filtering), not a control-flow
 * tag.
 *
 * On every tick: fetch -> decode -> apply Quirk(msg, ctx) ->
 * validate against libs/spec/schema's FeedMessageSchema -> re-encode
 * -> putSource -> scheduleReconciliation.
 *
 * `realtime.upstream_vehicle_positions` is REQUIRED. A feed without
 * it is treated as "no realtime" (skipped). No fallback to
 * `realtime.vehicle_positions` -- that field is the consumer
 * slot (proxy URL) and polling it would make the server poll
 * itself, which is the circular dependency the upstream /
 * consumer split exists to avoid.
 *
 * Errors are logged via pino but don't crash the loop. Decode
 * failures on individual sources are surfaced through
 * `Reconciled.failed` and do not abort the whole merge.
 */
import type { ResolvedFeed } from './feeds.js';
import { fetchVehiclePositions, UpstreamFetchError } from './upstream.js';
import { loadAdapter, type QuirkContext } from './adapter.js';
import { FeedMessageSchema } from '@n3ary/gtfs-spec/schema';
import { putClean, putSource, reEncode, listSourcesForFeed } from './store.js';
import { reconcile } from './reconcile.js';
import type { Logger } from 'pino';

export interface PollHandle {
  /** Stop polling and clear every interval. Idempotent. */
  stop(): void;
  /** Cancel any in-flight reconciliation timer. */
  flushReconciliation?(): void;
}

/** Per-feed poll plan. The served URL is `primary`; everything
 *  in `extras` is polled + stored and contributes to the
 *  reconciled served stream. */
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

/** Reconciliation debounce: N source updates within
 *  RECONCILE_DEBOUNCE_MS collapse into one merge pass. The
 *  poll cadence is 15 s, the primary + N extras fire within
 *  ~1 s of each other (Fastify's startup is parallel), so a
 *  short debounce is enough to coalesce one full poll cycle
 *  into a single merge. The CF edge cache is 5 s, so the
 *  reconciliation latency is invisible to consumers. */
const RECONCILE_DEBOUNCE_MS = 500;
const reconciliationTimers = new Map<string, NodeJS.Timeout>();

function scheduleReconciliation(feedId: string, log: Logger): void {
  const existing = reconciliationTimers.get(feedId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    reconciliationTimers.delete(feedId);
    try {
      const sources = listSourcesForFeed(feedId);
      if (sources.length === 0) return;
      const result = reconcile(sources);
      const appliedAt = new Date();
      // The reconciled bytes are what the consumer reads. The
      // fetchedAt we report is the most recent source we
      // touched -- gives the consumer an honest "when was the
      // upstream last live" signal even though we just rebuilt
      // the bytes.
      const fetchedAt = sources.reduce(
        (latest, s) => (s.fetchedAt > latest ? s.fetchedAt : latest),
        sources[0]!.fetchedAt,
      );
      putClean({ feedId, fetchedAt, appliedAt, bytes: result.bytes, entityCount: result.entityCount });
      log.debug(
        {
          feedId,
          entityCount: result.entityCount,
          sources: result.sources,
          empty: result.empty,
          failed: result.failed,
        },
        'reconciled',
      );
    } catch (err) {
      log.error({ feedId, err }, 'reconciliation failed');
    }
  }, RECONCILE_DEBOUNCE_MS);
  reconciliationTimers.set(feedId, handle);
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
      const timer = reconciliationTimers.get(feed.id);
      if (timer) {
        clearTimeout(timer);
        reconciliationTimers.delete(feed.id);
      }
    },
    flushReconciliation: () => {
      const timer = reconciliationTimers.get(feed.id);
      if (timer) {
        clearTimeout(timer);
        reconciliationTimers.delete(feed.id);
      }
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
      // The reconciled stream is what consumers read; the
      // debounce coalesces a full poll cycle into a single merge.
      scheduleReconciliation(feed.id, log);
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
