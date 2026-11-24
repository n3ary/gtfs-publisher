/**
 * poller.ts — per-feed polling loop.
 *
 * One setInterval per feed, firing every `intervalMs` (15 s
 * today). Each tick fetches ALL of the feed's sources in
 * parallel (primary + extras), waits for each to settle
 * (resolve or reject via its own per-fetch timeout), then
 * decides what to putClean:
 *
 *   - 0 sources succeeded (every fetch timed out or errored):
 *     keep the previous putClean, log loud. Stale-but-served
 *     beats blank for a transient upstream blip.
 *
 *   - exactly 1 source succeeded: putClean that source's
 *     bytes directly. No merge work -- the common case for
 *     feeds that have a single stream.
 *
 *   - 2+ sources succeeded: call reconcile() to dedupe
 *     per-vehicle + freshest-wins, then putClean the merged
 *     bytes. See apps/gtfs-rt/src/reconcile.ts.
 *
 * Why one interval, not N: the cycle is the right unit of
 * freshness. A primary that polls on its own clock and
 * extras on theirs means the served snapshot is "primary
 * from cycle N, extras from cycle N-1" with no clean way to
 * know which is which. A unified tick gets you
 * "everything from cycle N, or from the last good cycle if
 * this one failed" -- a single, honest freshness signal.
 *
 * Per-source state (putSource) is still maintained for
 * /healthz observability -- the operator wants to know which
 * upstream is slow, even if the served stream is merged.
 *
 * In-flight guard: a tick that takes longer than intervalMs
 * (e.g. a 10 s timeout on a slow upstream) must not stack a
 * second tick on top. The next interval tick is dropped if
 * the previous one is still running; the next slot will
 * pick up the work.
 *
 * `realtime.upstream_vehicle_positions` is REQUIRED. A feed
 * without it is treated as "no realtime" (skipped). No
 * fallback to `realtime.vehicle_positions` -- that field is
 * the consumer slot (proxy URL) and polling it would make
 * the server poll itself, which is the circular dependency
 * the upstream / consumer split exists to avoid.
 *
 * Errors are logged via pino but don't crash the loop.
 */
import type { ResolvedFeed } from './feeds.js';
import { fetchVehiclePositions, UpstreamFetchError } from './upstream.js';
import { loadAdapter, type QuirkContext } from './adapter.js';
import { FeedMessageSchema } from '@n3ary/gtfs-spec/schema';
import { putClean, putSource, reEncode } from './store.js';
import { reconcile, type SourceSnapshot } from './reconcile.js';
import type { Logger } from 'pino';

export interface PollHandle {
  /** Stop polling and clear the interval. Idempotent. */
  stop(): void;
}

/** Per-feed poll plan. The primary URL is what feeds the
 *  served stream when only one source succeeds; everything in
 *  `extras` is fetched in parallel and contributes when it
 *  comes back. */
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

  let stopped = false;
  let inFlight = false;

  const handle = setInterval(() => {
    if (stopped || inFlight) return;
    inFlight = true;
    void tick(feed, plan, upstreamTimeoutMs, log).finally(() => {
      inFlight = false;
    });
  }, intervalMs);

  // First tick immediately so the store is warm before the
  // first request lands (avoids cold-start 502s for users).
  // Fire-and-forget: errors are surfaced through the log, not
  // through the handle.
  if (!inFlight) {
    inFlight = true;
    void tick(feed, plan, upstreamTimeoutMs, log).finally(() => {
      inFlight = false;
    });
  }

  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}

/** One poll cycle: parallel-fetch every source, run each
 *  through the per-feed Quirk + spec validation, then
 *  decide what to putClean based on how many succeeded. */
async function tick(
  feed: ResolvedFeed,
  plan: PollPlan,
  upstreamTimeoutMs: number,
  log: Logger,
): Promise<void> {
  const urls = [plan.primary, ...plan.extras];
  const roles: Array<'primary' | 'extra'> = urls.map((u) =>
    u === plan.primary ? 'primary' : 'extra',
  );

  // Parallel fetch. allSettled (not all) so a single timeout
  // doesn't short-circuit the rest of the cycle.
  const settled = await Promise.allSettled(
    urls.map((url) => fetchVehiclePositions(url, upstreamTimeoutMs)),
  );

  // Run each successful fetch through the per-feed Quirk +
  // spec validation. Failures drop the source, not the whole
  // cycle -- this is the whole point of fetching in parallel.
  const valid: SourceSnapshot[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    const url = urls[i]!;
    const role = roles[i]!;
    if (r.status === 'rejected') {
      const reason = (r.reason as Error | undefined)?.message ?? String(r.reason);
      log.warn({ feedId: feed.id, url, role, err: reason }, 'upstream fetch failed');
      continue;
    }
    const { feedMessage, fetchedAt } = r.value;
    const quirk = await loadAdapter(feed);
    const ctx: QuirkContext = {
      url,
      feed: { id: feed.id, name: feed.name, country: feed.country },
    };
    const cleaned = quirk ? quirk(feedMessage, ctx) : feedMessage;

    const parseResult = FeedMessageSchema.safeParse(cleaned);
    if (!parseResult.success) {
      log.warn(
        { feedId: feed.id, url, role, issues: parseResult.error.issues.slice(0, 5) },
        'adapter output failed FeedMessageSchema; dropping source',
      );
      continue;
    }

    const { bytes, entityCount } = reEncode(
      parseResult.data as unknown as Parameters<typeof reEncode>[0],
    );
    const appliedAt = new Date();
    putSource({ feedId: feed.id, url, role, fetchedAt, appliedAt, bytes, entityCount });
    valid.push({ url, role, bytes, fetchedAt, appliedAt, entityCount });
  }

  if (valid.length === 0) {
    // Every source timed out or errored. Keep the previous
    // putClean -- a transient upstream blip shouldn't take
    // the live view down. The log is the failure signal.
    log.error(
      { feedId: feed.id, sources: urls, roles },
      'all sources failed this cycle; keeping previous putClean',
    );
    return;
  }

  if (valid.length === 1) {
    // Single source succeeded -- no merge work. Use its
    // bytes directly. This is the common case (most feeds
    // have exactly one stream) and avoids the cost of a
    // decode-merge-encode round trip for no benefit.
    const only = valid[0]!;
    putClean({
      feedId: feed.id,
      fetchedAt: only.fetchedAt,
      appliedAt: new Date(),
      bytes: only.bytes,
      entityCount: only.entityCount,
    });
    log.debug(
      { feedId: feed.id, source: only.url, role: only.role, entityCount: only.entityCount },
      'served (single source)',
    );
    return;
  }

  // 2+ sources succeeded -- merge.
  const reconciled = reconcile(valid);
  // The served `fetchedAt` is the most recent source we
  // touched, so the consumer's "how fresh is this snapshot"
  // signal is honest even though we just rebuilt the bytes.
  const fetchedAt = valid.reduce(
    (latest, s) => (s.fetchedAt > latest ? s.fetchedAt : latest),
    valid[0]!.fetchedAt,
  );
  putClean({
    feedId: feed.id,
    fetchedAt,
    appliedAt: new Date(),
    bytes: reconciled.bytes,
    entityCount: reconciled.entityCount,
  });
  log.debug(
    {
      feedId: feed.id,
      entityCount: reconciled.entityCount,
      sources: reconciled.sources,
      empty: reconciled.empty,
      failed: reconciled.failed,
    },
    'served (reconciled)',
  );
}
