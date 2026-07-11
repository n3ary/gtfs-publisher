/**
 * poller.test.ts — pins the per-feed poll-plan behavior so the
 * upstream / consumer split can't silently regress.
 *
 * Two pieces of behavior are pinned here:
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
    // The previous implementation read
    // `rt.upstream_vehicle_positions ?? rt.vehicle_positions` as a
    // "transitional" crutch. That would re-introduce the circular
    // dependency the split exists to avoid: the consumer slot
    // (vehicle_positions) holds the proxy URL, so polling it
    // would have the server poll itself.
    expect(POLLER_SRC).not.toMatch(
      /upstream_vehicle_positions\s*\?\?\s*(?:rt\.)?vehicle_positions/,
    );
  });

  it('reads only realtime.upstream_vehicle_positions (single read, no ?? fallback)', () => {
    // The buildPollPlan() function is the single source of truth
    // for "what URL the server polls" -- and it reads ONE field,
    // upstream_vehicle_positions, with no fallback chain. (The
    // `?? []` on extra_vehicle_positions is fine -- that field is
    // optional, not the served URL.)
    const planBlock = POLLER_SRC.match(/buildPollPlan[\s\S]*?^}/m);
    expect(planBlock).not.toBeNull();
    expect(planBlock![0]).toMatch(/upstream_vehicle_positions/);
    // Specifically: no `upstream_vehicle_positions ?? ...` chain.
    expect(planBlock![0]).not.toMatch(/upstream_vehicle_positions\s*\?\?/);
  });

  it('logs a clear warning + returns a no-op handle when upstream_vehicle_positions is missing', () => {
    // A feed without upstream_vehicle_positions is treated as
    // "no realtime" -- not an error, not a fallback to
    // vehicle_positions, just a logged warning + no-op handle.
    expect(POLLER_SRC).toMatch(
      /no realtime\.upstream_vehicle_positions; not polling/,
    );
  });
});

describe('poller: plan shape is { primary, extras[] }, not { role, url }[]', () => {
  it('declares the PollPlan interface with primary + extras, not role', () => {
    // The old plan shape was a flat list of { role, url }. The
    // new plan is { primary, extras } so the served URL is
    // explicit, not a role tag on the URL.
    const planIface = POLLER_SRC.match(/interface\s+PollPlan[\s\S]*?^}/m);
    expect(planIface).not.toBeNull();
    expect(planIface![0]).toMatch(/primary:\s*string/);
    expect(planIface![0]).toMatch(/extras:\s*string\[\]/);
    expect(planIface![0]).not.toMatch(/role/);
  });

  it('derives the role from url === plan.primary, not from a stored role tag on the URL', () => {
    // The makeTick factory receives `isPrimary: boolean` and
    // derives the role for putSource. The role string is a
    // stored attribute on the per-URL source record, not a
    // control-flow tag on the URL.
    expect(POLLER_SRC).toMatch(/const\s+isPrimary\s*=\s*url\s*===\s*plan\.primary/);
    expect(POLLER_SRC).toMatch(/const\s+role:\s*'primary'\s*\|\s*'extra'\s*=\s*isPrimary\s*\?\s*'primary'\s*:\s*'extra'/);
  });

  it('iterates [plan.primary, ...plan.extras] in startPolling', () => {
    // The polling loop iterates the served URL first, then the
    // extras. The order doesn't affect correctness (each URL has
    // its own setInterval) but it makes the served URL obvious
    // in logs.
    expect(POLLER_SRC).toMatch(/for\s*\(\s*const\s+url\s+of\s+\[plan\.primary,\s*\.\.\.plan\.extras\]\s*\)/);
  });
});
