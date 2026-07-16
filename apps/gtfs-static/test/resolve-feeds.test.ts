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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.GTFS_RT_PROXY_BASE_URL;
});

describe('resolve-feeds: publish set derived from feeds/<id>/', () => {
  it('does NOT consult include[] (whitelist removed)', () => {
    // The publish set is purely from feeds/<id>/config.json presence.
    // No `include[]` array is consulted.
    expect(RESOLVE_FEEDS_SRC).not.toMatch(/include\s*:/);
  });

  it('hard-errors on orphan enhances (no silent drop)', () => {
    // Every feeds/<id>/ must match a Transitous source name.
    // A mismatch is a hard build error, not a warning.
    expect(RESOLVE_FEEDS_SRC).toMatch(/throw new Error[\s\S]*?orphan override\(/i);
  });

  it('ignores feeds/<id>/ without an enhances field', () => {
    // A feeds/<id>/config.json without `enhances` is skipped (not an error).
    expect(RESOLVE_FEEDS_SRC).toMatch(/if \(!cfg\.enhances\)/);
  });

  it('derives publish set from enhances values', () => {
    // The `enhances` value in each feeds/<id>/config.json is the key
    // into the Transitous source list.
    expect(RESOLVE_FEEDS_SRC).toMatch(/byTransitousName\.set\(cfg\.enhances/);
  });

  it('skips RT sibling sources (gtfs-rt spec)', () => {
    // A Transitous entry with spec "gtfs-rt" is consumed by
    // resolveRealtimeForName and NOT emitted as a standalone feed.
    expect(RESOLVE_FEEDS_SRC).toMatch(/if \(raw\.spec === .gtfs-rt.\) continue;/);
  });

  it('deduplicates feeds by id', () => {
    // If the same feed id appears twice (e.g. two Transitous sources
    // with the same name), only the first is emitted.
    expect(RESOLVE_FEEDS_SRC).toMatch(/seenIds\.has\(projected\.feed!\.id\)/);
  });
});

describe('resolve-feeds: realtime URL split', () => {
  it('splits vehicle_positions and upstream_vehicle_positions', () => {
    // The proxy rewrite separates "what the consumer polls" from
    // "what the server polls". This prevents the server from
    // polling its own proxy endpoint (circular dependency).
    expect(RESOLVE_FEEDS_SRC).toMatch(/vehicle_positions:\s*`\$\{RT_PROXY_BASE_URL\}/);
    expect(RESOLVE_FEEDS_SRC).toMatch(/upstream_vehicle_positions:/);
  });

  it('uses upstream_vehicle_positions, not vehicle_positions, as the poll source', () => {
    // The poll source is `upstream_vehicle_positions` (MDB / operator URL).
    // `vehicle_positions` is the consumer slot (gtfs-rt.n3ary.com proxy URL).
    // A per-feed config override can populate upstream_vehicle_positions;
    // the poll source uses this override over the MDB default.
    // Using vehicle_positions as the poll source would make the server
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
    // mdb-id, a Tursib source with no RT, an Oradea source (OTL SA,
    // mdb-2101), and a Timisoara source (SMTT, mdb-2868). The RT sibling
    // shares the schedule feed's name -- that's how resolveRealtimeForName
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
        {
          name: 'Oradea',
          type: 'mobility-database',
          'mdb-id': '2101',
        },
        {
          // U+0219 Ș with comma below — matches both the Transitous source
          // name and feeds/timisoara/config.json's enhances field.
          name: 'Timi\u0219oara',
          type: 'mobility-database',
          'mdb-id': '2868',
        },
        {
          name: 'Brasov',
          type: 'mobility-database',
          'mdb-id': '2143',
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
      'mdb-2143.json': {}, // Brasov — static only, no RT
    };

    // Capture the GitHub tree call too -- the mdb-rt module
    // fetches the catalog tree to find catalog files.
    const ghTree = {
      tree: [
        { type: 'blob', path: 'catalogs/sources/gtfs/realtime/mdb-1234.json' },
      ],
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('transitous') && url.endsWith('/ro.json')) {
        return new Response(JSON.stringify(transitousPayload));
      }
      if (url.includes('transitous') && url.includes('/feeds/')) {
        // transitous feed file for any non-ro country — return empty sources
        // so only the explicitly-covered countries appear in the feed list.
        return new Response(JSON.stringify({ sources: [] }));
      }
      if (url.includes('api.github.com') && url.includes('git/trees')) {
        return new Response(JSON.stringify(ghTree));
      }
      if (url.includes('mdb-1234.json')) {
        return new Response(JSON.stringify(mdbCatalog['mdb-1234.json']));
      }
      if (url.includes('mdb-2143.json')) {
        return new Response(JSON.stringify(mdbCatalog['mdb-2143.json']));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    // Stub before resetModules so the mock is active when
    // resolve-feeds.ts re-executes on import.
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
    // Only Oradea and Timisoara are covered; Cluj-Napoca and Tursib per-feed
    // configs (real files on disk) have no Transitous match -- orphan error
    // lists them alphabetically: cluj-napoca, tursib.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('transitous') && url.endsWith('/ro.json')) {
        return new Response(JSON.stringify({
          sources: [
            { name: 'Oradea', type: 'mobility-database', 'mdb-id': '2101' },
            { name: 'Timisoara', type: 'mobility-database', 'mdb-id': '2868' },
          ],
        }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));

    vi.resetModules();
    const { resolveFeeds } = await import('../src/resolve-feeds.ts');
    await expect(resolveFeeds()).rejects.toThrow(/orphan override/i);
  });
});
