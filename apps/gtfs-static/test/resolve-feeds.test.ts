/**
 * resolve-feeds.test.ts — pins the publish-set + realtime-URL merge
 * behavior introduced when feeds/<id>/config.json became the
 * single source of truth for "this feed is published through
 * gtfs-rt.n3ary.com".
 *
 * Two pieces of behavior are pinned here:
 *
 *   1. Publish set is auto-derived from feeds/<id>/config.json
 *      presence (matched by the config's `enhances` value against
 *      Transitous). The `include[]` whitelist is gone from
 *      `countries.json`. An override whose `enhances` value does
 *      not match any Transitous source is a HARD build error
 *      (orphan), not a warning.
 *
 *   2. Realtime URL split: a feed with a per-feed config has
 *      `vehicle_positions` auto-rewritten to the canonical gtfs-rt
 *      proxy URL and `upstream_vehicle_positions` set to whatever
 *      upstream (MDB by default, per-feed config override) is
 *      available. The operator can opt out by setting
 *      `realtime.vehicle_positions` in the per-feed config
 *      explicitly.
 *
 * Most assertions here are "code review as test" -- regex on the
 * resolve-feeds.ts source -- to match the project's existing style
 * (see adapter-dispatch.test.ts). One end-to-end test exercises
 * the merge logic via mocked Transitous + MDB responses.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESOLVE_FEEDS_SRC = readFileSync(
  join(HERE, '..', 'src', 'resolve-feeds.ts'),
  'utf8',
);

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  if (ORIGINAL_FETCH) globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  delete process.env.GTFS_RT_PROXY_BASE_URL;
});

describe('resolve-feeds: publish set derived from feeds/<id>/', () => {
  it('does NOT consult include[] (whitelist removed)', () => {
    // The auto-derive machinery builds the publish set from
    // `overrides.keys()` (the set of feeds/<id>/config.json
    // directories with an `enhances` value). The old
    // `includeWhitelist` is gone.
    expect(RESOLVE_FEEDS_SRC).not.toMatch(/includeWhitelist/);
    expect(RESOLVE_FEEDS_SRC).not.toMatch(/config\.include/);
  });

  it('uses the override map (feeds/<id>/ presence) as the publish set', () => {
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /publishNames\s*=\s*new Set\(overrides\.keys\(\)\)/,
    );
  });

  it('hard-errors on orphan overrides (enhances value with no Transitous match)', () => {
    // The old "warn about orphan overrides" path is promoted
    // to a thrown error. The error message names the offending
    // directory so the operator can fix the typo or remove
    // the dead config.
    expect(RESOLVE_FEEDS_SRC).toMatch(/orphans\.push/);
    expect(RESOLVE_FEEDS_SRC).toMatch(/throw new Error\([\s\S]*orphans\.length/);
    expect(RESOLVE_FEEDS_SRC).not.toMatch(
      /orphan overrides[\s\S]*console\.warn/,
    );
  });
});

describe('resolve-feeds: realtime URL split (proxy + upstream)', () => {
  it('rewrites vehicle_positions to the canonical proxy URL when override is present', () => {
    // The proxy URL is computed from RT_PROXY_BASE_URL +
    // override.dir + the canonical endpoint suffix.
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /\$\{RT_PROXY_BASE_URL\}\/rt\/\$\{override\.dir\}\/vehicle_positions/,
    );
  });

  it('honours an explicit realtime.vehicle_positions override (operator opt-out)', () => {
    // The rewrite only fires when the per-feed config did NOT
    // explicitly set realtime.vehicle_positions. Operators can
    // point a feed at a different proxy (e.g. staging) by
    // setting the field themselves.
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /c\.realtime\?\.vehicle_positions\s*===\s*undefined/,
    );
  });

  it('moves MDB vehicle_positions discovery into upstream_vehicle_positions', () => {
    // MDB fills `vehicle_positions` on the mdbRealtime base. The
    // merge moves it into `upstream_vehicle_positions` (the new
    // server's poll source) at merge time, so the consumer slot
    // (vehicle_positions) stays clear for the proxy URL rewrite
    // below. The per-feed config can override upstream_vehicle_positions
    // explicitly, but there is NO `?? realtime.vehicle_positions`
    // fallback -- that would re-introduce the circular dependency
    // the split exists to avoid.
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /delete realtime\.vehicle_positions/,
    );
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /realtime\.upstream_vehicle_positions\s*\?\?\s*realtime\.vehicle_positions/,
    );
  });

  it('does NOT use vehicle_positions as a fallback for upstream_vehicle_positions in the proxy rewrite', () => {
    // The proxy URL rewrite only reads `upstream_vehicle_positions`,
    // never `vehicle_positions` -- the latter is the consumer
    // slot (proxy URL), and using it as the source for "what the
    // server polls" would have the server poll itself.
    // The branch reads `realtime.upstream_vehicle_positions`
    // (single read, no `??`).
    const rewriteBlock = RESOLVE_FEEDS_SRC.match(
      /override\s*&&[\s\S]*?vehicle_positions:\s*`\$\{RT_PROXY_BASE_URL\}\/rt\/\$\{override\.dir\}\/vehicle_positions`/,
    );
    expect(rewriteBlock).not.toBeNull();
    expect(rewriteBlock![0]).toMatch(/realtime\.upstream_vehicle_positions/);
    expect(rewriteBlock![0]).not.toMatch(/\?\?/);
  });

  it('preserves the existing extras logic (cfgExtras vs adapterExtras)', () => {
    // The extras merge is unchanged: explicit per-feed wins over
    // adapter's `extraVehiclePositions()` return value.
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /cfgExtras\s*!==\s*undefined\s*\?\s*cfgExtras\s*:\s*adapterExtras/,
    );
  });

  it('reads RT_PROXY_BASE_URL from env with a default', () => {
    // Override the canonical base via env for staging / local
    // dev. Default is the production gtfs-rt.n3ary.com host.
    expect(RESOLVE_FEEDS_SRC).toMatch(
      /process\.env\.GTFS_RT_PROXY_BASE_URL\s*\?\?\s*['"]https:\/\/gtfs-rt\.n3ary\.com['"]/,
    );
  });
});

describe('resolve-feeds: end-to-end merge', () => {
  // Mock Transitous + MDB and exercise the real resolveFeeds()
  // so the merge logic is exercised, not just pattern-matched.
  it('publishes a feed with per-feed config: rewrites vehicle_positions, fills upstream_vehicle_positions from MDB', async () => {
    // Transitous ro.json: a single Cluj-Napoca schedule source with
    // an RT sibling (same `name`, `spec: "gtfs-rt"`) carrying an
    // mdb-id, and a Tursib source with no RT. The RT sibling shares
    // the schedule feed's name -- that's how resolveRealtimeForName
    // pairs them.
    const transitousPayload = {
      sources: [
        {
          name: 'Cluj-Napoca',
          type: 'http',
          url: 'https://gtfs.clujnapoca.ro/gtfs.zip',
          license: { 'spdx-identifier': 'CC-BY-SA-4.0' },
        },
        {
          name: 'Cluj-Napoca',
          spec: 'gtfs-rt',
          type: 'mobility-database',
          'mdb-id': '1234',
        },
        {
          name: 'Tursib',
          type: 'http',
          url: 'https://gtfs.tursib.ro/gtfs.zip',
          license: { 'spdx-identifier': 'CC-BY-SA-4.0' },
        },
      ],
    };

    // MDB catalog lookup: return one direct_download URL for
    // mdb-id 1234 (entity_type 'vp' = vehicle_positions).
    const mdbCatalog = {
      'mdb-1234.json': {
        urls: { direct_download: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions' },
        entity_type: ['vp'],
      },
    };

    // Capture the GitHub tree call too -- the mdb-rt module
    // fetches the catalog tree to find catalog files.
    const ghTree = {
      tree: [
        { type: 'blob', path: 'catalogs/sources/gtfs/realtime/mdb-1234.json' },
      ],
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('transitous') && url.endsWith('/ro.json')) {
        return new Response(JSON.stringify(transitousPayload));
      }
      if (url.includes('api.github.com') && url.includes('git/trees')) {
        return new Response(JSON.stringify(ghTree));
      }
      if (url.includes('mdb-1234.json')) {
        return new Response(JSON.stringify(mdbCatalog['mdb-1234.json']));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as never;

    // Force a fresh import so the mocked fetch is picked up
    // and the mdb-rt tree cache starts empty.
    vi.resetModules();
    const { resolveFeeds } = await import('../src/resolve-feeds.ts');
    const feeds = await resolveFeeds();

    // Tursib: published, no realtime (MDB returned nothing for
    // it; per-feed config has no realtime block).
    const tursib = feeds.find((f) => f.id === 'tursib');
    expect(tursib).toBeDefined();
    expect(tursib!.realtime).toBeNull();

    // Cluj-Napoca: published, vehicle_positions is the proxy
    // URL, upstream_vehicle_positions is the MDB URL, the
    // override's extras slot is the empty default (cluj
    // adapter returns [] today).
    const cluj = feeds.find((f) => f.id === 'cluj-napoca');
    expect(cluj).toBeDefined();
    expect(cluj!.realtime).toEqual(
      expect.objectContaining({
        vehicle_positions: 'https://gtfs-rt.n3ary.com/rt/cluj-napoca/vehicle_positions',
        upstream_vehicle_positions: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions',
        extra_vehicle_positions: [],
      }),
    );
  });

  it('throws when a per-feed config enhances a name not in Transitous', async () => {
    // No Transitous sources for RO at all. Tursib's per-feed
    // config (real file on disk) enhances "Tursib" but there's
    // no Transitous match -- orphan error.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('transitous') && url.endsWith('/ro.json')) {
        return new Response(JSON.stringify({ sources: [] }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as never;

    vi.resetModules();
    const { resolveFeeds } = await import('../src/resolve-feeds.ts');
    await expect(resolveFeeds()).rejects.toThrow(/orphan override/i);
  });
});
