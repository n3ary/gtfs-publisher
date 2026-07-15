/**
 * poller.test.ts — pins the per-feed polling behavior so the
 * parallel-fetch + conditional-reconcile design can't silently
 * regress.
 *
 * Three pieces of behavior are pinned here:
 *
 *   1. `realtime.upstream_vehicle_positions` is REQUIRED. A feed
 *      without it gets a no-op poll handle and a log warning. No
 *      fallback to `realtime.vehicle_positions` -- that field is
 *      the consumer-side (proxy URL) and using it as the source
 *      for "what the server polls" would have the server poll
 *      itself, which is the circular dependency the split exists
 *      to avoid.
 *
 *   2. The poll plan is `{ primary, extras[] }`, not a flat list
 *      of `{ role, url }` items. The "primary vs extra" split is
 *      a property of the plan, not a role tag on the URL.
 *
 *   3. The tick flow is parallel + conditional: every source is
 *      fetched in one Promise.allSettled, then the tick decides
 *      what to putClean based on how many succeeded. 0 -> keep
 *      previous; 1 -> use it directly; >=2 -> reconcile. No
 *      debounce, no per-URL setIntervals.
 *
 * Most assertions here are "code review as test" -- regex on the
 * poller.ts source -- to match the project's existing style (see
 * adapter-dispatch.test.ts and resolve-feeds.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// `pnpm test` runs after `pnpm build`, so vitest sees BOTH the
// src test file and its compiled dist/ copy. The compiled copy
// runs from apps/gtfs-rt/dist/, where `poller.ts` (relative
// to the test) doesn't exist -- the path needs to navigate
// up one level first so the same file is found regardless of
// which copy vitest is running.
const POLLER_SRC = readFileSync(join(HERE, '..', 'src', 'poller.ts'), 'utf8');

describe('poller: upstream_vehicle_positions is required (no vehicle_positions fallback)', () => {
  it('does NOT fall back to realtime.vehicle_positions when upstream_vehicle_positions is missing', () => {
    expect(POLLER_SRC).not.toMatch(
      /upstream_vehicle_positions\s*\?\?\s*(?:rt\.)?vehicle_positions/,
    );
  });

  it('reads only realtime.upstream_vehicle_positions in buildPollPlan (single read, no ?? fallback)', () => {
    const planBlock = POLLER_SRC.match(/buildPollPlan[\s\S]*?^}/m);
    expect(planBlock).not.toBeNull();
    expect(planBlock![0]).toMatch(/upstream_vehicle_positions/);
    expect(planBlock![0]).not.toMatch(/upstream_vehicle_positions\s*\?\?/);
  });

  it('logs a clear warning + returns a no-op handle when upstream_vehicle_positions is missing', () => {
    expect(POLLER_SRC).toMatch(
      /no realtime\.upstream_vehicle_positions; not polling/,
    );
  });
});

describe('poller: plan shape is { primary, extras[] }', () => {
  it('declares the PollPlan interface with primary + extras', () => {
    const planIface = POLLER_SRC.match(/interface\s+PollPlan[\s\S]*?^}/m);
    expect(planIface).not.toBeNull();
    expect(planIface![0]).toMatch(/primary:\s*string/);
    expect(planIface![0]).toMatch(/extras:\s*string\[\]/);
  });
});

describe('poller: parallel fetch + conditional reconcile', () => {
  it('fetches every source with one Promise.allSettled (no per-URL setInterval)', () => {
    // The cycle is the unit of freshness. Each tick fetches
    // every URL in parallel and waits for all to settle.
    // The old design had one setInterval per URL which made
    // the cycle implicit and racy.
    expect(POLLER_SRC).toMatch(/Promise\.allSettled\(/);
    // Only ONE setInterval call -- one per feed, not N.
    const setIntervalMatches = POLLER_SRC.match(/setInterval\(/g) ?? [];
    expect(setIntervalMatches).toHaveLength(1);
  });

  it('does NOT use a debounce or per-URL scheduleReconciliation', () => {
    // The first cut used N independent setIntervals + a
    // debounce timer to coalesce them. That added 500ms
    // staleness for no real win -- the merge is cheap and
    // the per-cycle parallel fetch is structurally
    // deterministic. The new design is debounce-free.
    expect(POLLER_SRC).not.toMatch(/scheduleReconciliation/);
    expect(POLLER_SRC).not.toMatch(/RECONCILE_DEBOUNCE_MS/);
    expect(POLLER_SRC).not.toMatch(/reconciliationTimers/);
  });

  it('guards against stacked ticks when a cycle runs longer than intervalMs', () => {
    // A 10 s per-fetch timeout on a slow upstream can stretch
    // a cycle beyond the 15 s interval. The in-flight guard
    // drops the second tick; the next slot picks up the work.
    expect(POLLER_SRC).toMatch(/inFlight/);
  });

  it('decides the putClean path by valid.length (0, 1, or >=2)', () => {
    // 0 sources succeeded -> keep previous putClean, log error.
    // 1 source succeeded -> putClean that source's bytes
    //   directly, no merge work.
    // >=2 sources succeeded -> reconcile() then putClean.
    expect(POLLER_SRC).toMatch(/if\s*\(\s*valid\.length\s*===\s*0\s*\)/);
    expect(POLLER_SRC).toMatch(/if\s*\(\s*valid\.length\s*===\s*1\s*\)/);
    // The >=2 branch is the final `reconcile(valid)` call after
    // the two early returns.
    expect(POLLER_SRC).toMatch(/reconcile\(valid\)/);
  });

  it('clears the interval on stop() (and the no-op handle is honest about it)', () => {
    // The real stop() must clearInterval. The no-op
    // `stop: () => {}` for the no-plan case is fine -- the
    // handle is returned before any setInterval is created.
    expect(POLLER_SRC).toMatch(/clearInterval\(handle\)/);
  });
});
