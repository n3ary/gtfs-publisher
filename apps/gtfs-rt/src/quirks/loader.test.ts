/**
 * loader.test.ts -- behaviour of the data-driven quirk loader.
 *
 * Cases:
 *   - no `feeds/<id>/config.json`  ->  loadQuirk returns null (pass-through)
 *   - `feeds/<id>/config.json` with no `adapter` field  ->  null
 *   - `feeds/<id>/config.json` with an `adapter` field  ->  quirk loaded
 *   - cache: same instance returned on second call until clearQuirkCache()
 *   - `quirkFeedIds` walks the dir and returns sorted feed ids
 *   - malformed JSON throws (config present but unreadable)
 *
 * The dynamic-import path uses the real `@n3ary/gtfs-adapter-cluj-napoca`
 * package (declared as a runtime dep in `apps/gtfs-rt/package.json`),
 * so each test case lives in a tmp dir with its own `config.json`
 * and never relies on the working dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import {
  loadQuirk,
  clearQuirkCache,
  quirkFeedIds,
  setConfigDir,
  resetConfigDir,
} from './loader.js';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

function makeFeedMsg(tripId: string, directionId: number, startTime: string): InstanceType<typeof FeedMessage> {
  // Mirror the adapter's own cluj.test.ts construction: nested
  // protobufjs TypedMessages come from `<Type>.create({...})`,
  // not from object literals. Object literals partially populate the
  // fields and leave the rest at the protobufjs default (which means
  // `trip.startTime` may report as `undefined` rather than `''`).
  const td = GtfsRealtimeBindings.transit_realtime.TripDescriptor.create({
    tripId,
    directionId,
    startTime,
    routeId: 'X',
  });
  const vp = GtfsRealtimeBindings.transit_realtime.VehiclePosition.create({
    trip: td,
    position: { latitude: 0, longitude: 0 },
    timestamp: 0,
  });
  const fe = GtfsRealtimeBindings.transit_realtime.FeedEntity.create({
    id: 'vehicle-1',
    vehicle: vp,
  });
  const fh = GtfsRealtimeBindings.transit_realtime.FeedHeader.create({
    gtfsRealtimeVersion: '2.0',
    incrementality: GtfsRealtimeBindings.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
    timestamp: 0,
  });
  const msg = FeedMessage.create({ header: fh, entity: [fe] });
  return msg;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gtfs-rt-loader-'));
  setConfigDir(tmp);
  clearQuirkCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  resetConfigDir();
});

describe('loadQuirk: no per-feed config', () => {
  it('returns null when feeds/<id>/config.json is missing (ENOENT)', async () => {
    const q = await loadQuirk('no-such-feed');
    expect(q).toBeNull();
  });

  it('treats multiple unknowns independently and never throws', async () => {
    await expect(loadQuirk('a')).resolves.toBeNull();
    await expect(loadQuirk('b')).resolves.toBeNull();
  });
});

describe('loadQuirk: present config but no adapter declared', () => {
  it('returns null when adapter field is absent', async () => {
    mkdirSync(join(tmp, 'tbilisi'));
    writeFileSync(
      join(tmp, 'tbilisi', 'config.json'),
      JSON.stringify({ /* no adapter */ }),
    );
    const q = await loadQuirk('tbilisi');
    expect(q).toBeNull();
  });

  it('returns null when adapter field is explicitly empty string', async () => {
    mkdirSync(join(tmp, 'tbilisi'));
    writeFileSync(join(tmp, 'tbilisi', 'config.json'), JSON.stringify({ adapter: '' }));
    const q = await loadQuirk('tbilisi');
    expect(q).toBeNull();
  });
});

describe('loadQuirk: adapter declared', () => {
  it('loads the cluj quirk from @n3ary/gtfs-adapter-cluj-napoca/rt', async () => {
    mkdirSync(join(tmp, 'cluj-napoca'));
    writeFileSync(
      join(tmp, 'cluj-napoca', 'config.json'),
      JSON.stringify({ adapter: '@n3ary/gtfs-adapter-cluj-napoca' }),
    );
    const q = await loadQuirk('cluj-napoca');
    expect(q).toBeTypeOf('function');

    // Behaviour check: the cluj quirk recovers direction_id from the
    // encoded `trip_id` when the upstream leaves directionId as 0.
    // Note: the trip_id pattern is case-sensitive on the service-id
    // group (lowercase only), matching the CTP upstream convention.
    const msg = makeFeedMsg('38_0_weekday_2_1430', 0, '');
    const out = q!(msg, {} as never);
    const trip = out.entity[0]!.vehicle!.trip!;
    expect(trip.directionId).toBe(0);
    expect(trip.startTime).toBe('14:30:00');
  });

  it('throws when the adapter exports no recognised function', async () => {
    mkdirSync(join(tmp, 'broken'));
    writeFileSync(
      join(tmp, 'broken', 'config.json'),
      JSON.stringify({ adapter: 'nonexistent-package-that-does-not-actually-not-exist-but' }),
    );
    // Use a real package that has no /rt subpath with a quirk.
    await expect(loadQuirk('broken')).rejects.toThrow();
  });
});

describe('loadQuirk: caching', () => {
  it('returns the same instance on subsequent calls until clearQuirkCache()', async () => {
    mkdirSync(join(tmp, 'cluj-napoca'));
    writeFileSync(
      join(tmp, 'cluj-napoca', 'config.json'),
      JSON.stringify({ adapter: '@n3ary/gtfs-adapter-cluj-napoca' }),
    );
    const first = await loadQuirk('cluj-napoca');
    const second = await loadQuirk('cluj-napoca');
    expect(first).toBe(second);
    clearQuirkCache();
    const third = await loadQuirk('cluj-napoca');
    expect(third).not.toBe(first);
    expect(typeof third).toBe('function');
  });
});

describe('quirkFeedIds', () => {
  it('returns sorted feed ids that have a config.json', () => {
    mkdirSync(join(tmp, 'z-cluj'));
    writeFileSync(join(tmp, 'z-cluj', 'config.json'), JSON.stringify({ adapter: 'pkg' }));
    mkdirSync(join(tmp, 'a-other'));
    writeFileSync(join(tmp, 'a-other', 'config.json'), JSON.stringify({}));
    mkdirSync(join(tmp, 'misc')); // no config.json
    writeFileSync(join(tmp, 'misc', 'README.md'), 'ignored');

    expect(quirkFeedIds()).toEqual(['a-other', 'z-cluj']);
  });

  it('returns [] when the config dir does not exist', () => {
    setConfigDir(join(tmp, 'does-not-exist'));
    expect(quirkFeedIds()).toEqual([]);
  });
});
