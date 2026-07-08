/**
 * adapter.test.ts — loader behaviour.
 *
 * Coverage:
 *   - transitous / mobility-database / remote feeds -> null quirk
 *     (no adapter dynamic-import attempted)
 *   - adapter-type feeds with a publisher -> quirk loaded, called
 *     with (msg, ctx)
 *   - legacy 1-arg quirks (fn.length < 2) are wrapped: ctx is
 *     accepted but ignored; the function still receives msg
 *   - cache: same instance on repeated calls until cleared
 *   - failing dynamic-import (e.g. uninstalled package) -> null,
 *     no throw
 *   - adaptersWithQuirk() lists only the feed IDs whose adapter
 *     actually loaded (not the pass-through ones)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import {
  loadAdapter,
  clearAdapterCache,
  adaptersWithQuirk,
  type QuirkContext,
} from './adapter.js';
import type { ResolvedFeed } from './feeds.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

function makeFeed(overrides: Partial<ResolvedFeed> = {}): ResolvedFeed {
  return {
    id: 'cluj-napoca',
    name: 'Cluj-Napoca',
    country: 'RO',
    bbox: { minLat: 46.7, minLon: 23.5, maxLat: 46.8, maxLon: 23.6 },
    center: { lat: 46.77, lon: 23.6 },
    agencies: [],
    source: { type: 'adapter', publisher: '@n3ary/gtfs-adapter-cluj-napoca' },
    files: { sqlite_gz: '', gtfs_zip: null },
    size_bytes: { sqlite_gz: 0, gtfs_zip: null },
    hash: '',
    generated_at: '2026-07-01',
    timezone: 'Europe/Bucharest',
    license: { attribution_text: 'x' },
    realtime: { vehicle_positions: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions' },
    ...overrides,
  } as ResolvedFeed;
}

function makeMsg(tripId: string, dir: number, start: string) {
  return FeedMessage.create({
    header: { gtfsRealtimeVersion: '2.0' },
    entity: [
      { id: 'v1', vehicle: { trip: { tripId, directionId: dir, startTime: start }, position: { latitude: 0, longitude: 0 } } },
    ],
  });
}

beforeEach(() => {
  clearAdapterCache();
});

describe('loadAdapter: source flavour', () => {
  it('returns null for transitous-type feeds (no adapter package to import)', async () => {
    const q = await loadAdapter(makeFeed({ source: { type: 'transitous', publisher: 'Transitous', upstream_url: 'https://example.com/foo.zip' } }));
    expect(q).toBeNull();
  });

  it('returns null for mobility-database feeds', async () => {
    const q = await loadAdapter(makeFeed({ source: { type: 'mobility-database', publisher: 'MDB', upstream_url: 'https://example.com/foo.zip' } }));
    expect(q).toBeNull();
  });

  it('returns null for remote feeds', async () => {
    const q = await loadAdapter(makeFeed({ source: { type: 'remote', publisher: 'https://example.com', upstream_url: 'https://example.com/foo.zip' } }));
    expect(q).toBeNull();
  });
});

describe('loadAdapter: adapter-type feeds', () => {
  it('loads the live cluj adapter from @n3ary/gtfs-adapter-cluj-napoca/rt', async () => {
    const feed = makeFeed({
      source: { type: 'adapter', publisher: '@n3ary/gtfs-adapter-cluj-napoca', upstream_url: null },
    });
    const q = await loadAdapter(feed);
    expect(q).toBeTypeOf('function');

    // Behaviour check: the cluj quirk (1-arg legacy) is wrapped to
    // 2-arg (TEMP), so the call still works with a ctx.
    const ctx: QuirkContext = {
      url: 'https://cluj-rt-feed.gtfs.ro/vehiclePositions',
      feed: { id: 'cluj-napoca', name: 'Cluj-Napoca', country: 'RO' },
    };
    const out = q!(makeMsg('38_0_weekday_2_1430', 0, ''), ctx) as ReturnType<typeof FeedMessage.create>;
    const trip = out.entity[0]!.vehicle!.trip!;
    expect(trip.directionId).toBe(0);
    expect(trip.startTime).toBe('14:30:00');
  });
});

describe('loadAdapter: error paths', () => {
  it('returns null (does not throw) when the adapter package is unresolvable', async () => {
    const feed = makeFeed({
      id: 'broken',
      source: { type: 'adapter', publisher: 'this-package-does-not-exist-xyz123', upstream_url: null },
    });
    const q = await loadAdapter(feed);
    expect(q).toBeNull();
  });
});

describe('loadAdapter: caching', () => {
  it('returns the same instance on repeated calls', async () => {
    const feed = makeFeed();
    const a = await loadAdapter(feed);
    const b = await loadAdapter(feed);
    expect(a).toBe(b);
    clearAdapterCache();
    const c = await loadAdapter(feed);
    expect(c).not.toBe(a);
    expect(typeof c).toBe('function');
  });
});

describe('adaptersWithQuirk()', () => {
  it('lists only feeds whose adapter actually loaded (transitous feeds excluded)', async () => {
    await loadAdapter(makeFeed({ id: 'cluj-napoca' })); // adapter -> quirk loaded
    await loadAdapter(makeFeed({
      id: 'tursib',
      source: { type: 'transitous', publisher: 'Transitous', upstream_url: 'https://example.com/foo.zip' },
    })); // transitous -> null quirk
    expect(adaptersWithQuirk()).toEqual(['cluj-napoca']);
  });
});
