/**
 * reconcile.test.ts — pure-function unit tests for the multi-source
 * FeedMessage merger.
 *
 * Builds synthetic FeedMessages via the same protobufjs bindings
 * the runtime uses, encodes them, and feeds them through
 * `reconcile()`. The output is decoded back so the assertions
 * can compare structured data (entity count, vehicle ids, vehicle
 * timestamps) rather than raw bytes.
 *
 * What this catches: dedupe misses, freshest-wins inversions,
 * primary/extra tiebreak, decode failures from malformed bytes,
 * the empty-reconciled-message case, the gtfs_realtime_version
 * fallback when sources disagree.
 */
import { describe, it, expect } from 'vitest';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

import { reconcile, type SourceSnapshot } from './reconcile.js';

const { FeedMessage, FeedEntity, FeedHeader, VehiclePosition, VehicleDescriptor, TripDescriptor, Position } =
  GtfsRealtimeBindings.transit_realtime;

/** Build a synthetic FeedMessage with the given vehicle ids +
 *  per-vehicle timestamps, then encode to bytes (what the poller
 *  would store in putSource). */
function snapshotForVehicles(
  vehicles: Array<{ id: string; ts: number; lat?: number; lon?: number }>,
  headerTs = 1000,
): Uint8Array {
  const msg = FeedMessage.create({
    header: FeedHeader.create({
      gtfsRealtimeVersion: '2.0',
      incrementality: FeedHeader.Incrementality.FULL_DATASET,
      timestamp: headerTs,
    }),
    entity: vehicles.map((v) =>
      FeedEntity.create({
        id: v.id,
        vehicle: VehiclePosition.create({
          vehicle: VehicleDescriptor.create({ id: v.id }),
          trip: TripDescriptor.create({ tripId: `trip-${v.id}` }),
          position: Position.create({ latitude: v.lat ?? 46.77, longitude: v.lon ?? 23.6 }),
          timestamp: v.ts,
        }),
      }),
    ),
  });
  return FeedMessage.encode(msg).finish();
}

function asSource(
  url: string,
  role: 'primary' | 'extra',
  vehicles: Array<{ id: string; ts: number; lat?: number; lon?: number }>,
  headerTs = 1000,
): SourceSnapshot {
  return {
    url,
    role,
    bytes: snapshotForVehicles(vehicles, headerTs),
    fetchedAt: new Date(),
    appliedAt: new Date(),
    entityCount: vehicles.length,
  };
}

/** Decode the reconciled bytes back to a structured shape for assertions. */
function decodeEntities(bytes: Uint8Array): Array<{ id: string; ts: number; lat: number }> {
  const msg = FeedMessage.decode(bytes) as any;
  return (msg.entity ?? []).map((e: any) => ({
    id: e.vehicle.vehicle?.id ?? e.id ?? '',
    ts: Number(e.vehicle.timestamp),
    lat: e.vehicle.position.latitude,
  }));
}

describe('reconcile: dedupe + freshest-wins', () => {
  it('emits one entity per vehicle when the same id appears in two sources', () => {
    // Both sources report vehicle 42; the reconciler should
    // produce one entity, not two.
    const primary = asSource('https://primary/vp.pb', 'primary', [
      { id: '42', ts: 100 },
    ]);
    const extra = asSource('https://mirror/vp.pb', 'extra', [
      { id: '42', ts: 200 },
    ]);
    const result = reconcile([primary, extra]);
    const entities = decodeEntities(result.bytes);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.id).toBe('42');
    // Freshest (extra) wins.
    expect(entities[0]?.ts).toBe(200);
  });

  it('primary wins on equal timestamps (deterministic tiebreak)', () => {
    // Two sources, same vehicle, same ts. The earlier-declared
    // source (primary) wins because the merge processes sources
    // in order and the first occurrence sets the Map entry.
    const primary = asSource('https://primary/vp.pb', 'primary', [
      { id: '7', ts: 100, lat: 46.77 },
    ]);
    const extra = asSource('https://mirror/vp.pb', 'extra', [
      { id: '7', ts: 100, lat: 47.0 },
    ]);
    const result = reconcile([primary, extra]);
    const entities = decodeEntities(result.bytes);
    expect(entities).toHaveLength(1);
    // Primary's position survives the tie. Protobuf rounds the
    // float slightly; use toBeCloseTo to absorb the round-trip.
    expect(entities[0]?.lat).toBeCloseTo(46.77, 4);
  });

  it('extra with fresher timestamp wins over primary', () => {
    // The earlier-declared source does NOT always win -- only on
    // ties. The freshest entity always wins, regardless of role.
    const primary = asSource('https://primary/vp.pb', 'primary', [
      { id: '7', ts: 100, lat: 46.77 },
    ]);
    const extra = asSource('https://mirror/vp.pb', 'extra', [
      { id: '7', ts: 200, lat: 47.0 },
    ]);
    const result = reconcile([primary, extra]);
    const entities = decodeEntities(result.bytes);
    expect(entities).toHaveLength(1);
    expect(entities[0]?.ts).toBe(200);
    expect(entities[0]?.lat).toBe(47.0);
  });

  it('merges disjoint vehicle sets (union of both sources)', () => {
    const primary = asSource('https://primary/vp.pb', 'primary', [
      { id: '1', ts: 100 },
      { id: '2', ts: 100 },
    ]);
    const extra = asSource('https://mirror/vp.pb', 'extra', [
      { id: '3', ts: 100 },
      { id: '4', ts: 100 },
    ]);
    const result = reconcile([primary, extra]);
    const entities = decodeEntities(result.bytes);
    expect(entities.map((e) => e.id).sort()).toEqual(['1', '2', '3', '4']);
  });
});

describe('reconcile: source-level bookkeeping', () => {
  it('reports contributing sources vs empty vs failed', () => {
    const good = asSource('https://primary/vp.pb', 'primary', [{ id: '1', ts: 100 }]);
    const empty = asSource('https://mirror/vp.pb', 'extra', []);
    // Malformed bytes: encode garbage, wrap in a SourceSnapshot.
    const bad: SourceSnapshot = {
      url: 'https://broken/vp.pb',
      role: 'extra',
      bytes: new Uint8Array([0, 1, 2, 3, 4]),
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 0,
    };
    const result = reconcile([good, empty, bad]);
    expect(result.sources).toEqual(['https://primary/vp.pb']);
    expect(result.empty).toEqual(['https://mirror/vp.pb']);
    expect(result.failed).toEqual(['https://broken/vp.pb']);
  });

  it('produces an empty (but valid) FeedMessage when every source is empty', () => {
    const a = asSource('https://a/vp.pb', 'primary', []);
    const b = asSource('https://b/vp.pb', 'extra', []);
    const result = reconcile([a, b]);
    expect(result.entityCount).toBe(0);
    // Decoding the bytes is the assertion: a malformed empty
    // result would throw.
    const msg = FeedMessage.decode(result.bytes) as any;
    expect(msg.entity).toEqual([]);
    // Both sources had nothing to contribute.
    expect(result.sources).toEqual([]);
    expect(result.empty).toEqual(['https://a/vp.pb', 'https://b/vp.pb']);
  });

  it('produces an empty FeedMessage when a single source fails to decode', () => {
    const bad: SourceSnapshot = {
      url: 'https://broken/vp.pb',
      role: 'primary',
      bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 0,
    };
    const result = reconcile([bad]);
    expect(result.entityCount).toBe(0);
    expect(result.failed).toEqual(['https://broken/vp.pb']);
  });
});

describe('reconcile: header construction', () => {
  it('uses wall-clock timestamp on the reconciled header (not the max of source timestamps)', () => {
    // Sources from a minute ago; the reconciled message should
    // report "now" so the consumer can tell how fresh the served
    // snapshot is independent of source mix.
    const now = Math.floor(Date.now() / 1000);
    const old = asSource('https://primary/vp.pb', 'primary', [{ id: '1', ts: now - 60 }], 1000);
    const result = reconcile([old]);
    const msg = FeedMessage.decode(result.bytes) as any;
    expect(Number(msg.header.timestamp)).toBeGreaterThanOrEqual(now);
  });

  it('passes through gtfs_realtime_version when all sources agree', () => {
    // Synthesize a feed at version 1.0 to exercise the passthrough.
    const v1Bytes = (() => {
      const msg = FeedMessage.create({
        header: FeedHeader.create({
          gtfsRealtimeVersion: '1.0',
          incrementality: FeedHeader.Incrementality.FULL_DATASET,
          timestamp: 1000,
        }),
        entity: [],
      });
      return FeedMessage.encode(msg).finish();
    })();
    const src: SourceSnapshot = {
      url: 'https://legacy/vp.pb',
      role: 'primary',
      bytes: v1Bytes,
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 0,
    };
    const result = reconcile([src]);
    const msg = FeedMessage.decode(result.bytes) as any;
    expect(msg.header.gtfsRealtimeVersion).toBe('1.0');
  });

  it('falls back to 2.0 when sources disagree on version', () => {
    const v1 = (() => {
      const msg = FeedMessage.create({
        header: FeedHeader.create({
          gtfsRealtimeVersion: '1.0',
          incrementality: FeedHeader.Incrementality.FULL_DATASET,
          timestamp: 1000,
        }),
        entity: [],
      });
      return FeedMessage.encode(msg).finish();
    })();
    const v2 = asSource('https://b/vp.pb', 'extra', []);
    const legacy: SourceSnapshot = {
      url: 'https://a/vp.pb',
      role: 'primary',
      bytes: v1,
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 0,
    };
    const result = reconcile([legacy, v2]);
    const msg = FeedMessage.decode(result.bytes) as any;
    expect(msg.header.gtfsRealtimeVersion).toBe('2.0');
  });
});

describe('reconcile: vehicle id resolution', () => {
  it('falls back to entity.id when vehicle.vehicle.id is empty', () => {
    // Some feeds populate entity.id but not the VehicleDescriptor.
    // The merge key has to look at both -- otherwise we'd dedupe
    // against the empty string and emit one entity per source.
    const bytesFromEntityId = (() => {
      const msg = FeedMessage.create({
        header: FeedHeader.create({
          gtfsRealtimeVersion: '2.0',
          incrementality: FeedHeader.Incrementality.FULL_DATASET,
          timestamp: 1000,
        }),
        entity: [
          FeedEntity.create({
            id: 'bus-42',
            vehicle: VehiclePosition.create({
              // No VehicleDescriptor.id -- just trip + position + timestamp.
              trip: TripDescriptor.create({ tripId: 'T1' }),
              position: Position.create({ latitude: 46.77, longitude: 23.6 }),
              timestamp: 100,
            }),
          }),
        ],
      });
      return FeedMessage.encode(msg).finish();
    })();
    const a: SourceSnapshot = {
      url: 'https://a/vp.pb',
      role: 'primary',
      bytes: bytesFromEntityId,
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 1,
    };
    // Same vehicle id, also via entity.id path.
    const b = (() => {
      const msg = FeedMessage.create({
        header: FeedHeader.create({
          gtfsRealtimeVersion: '2.0',
          incrementality: FeedHeader.Incrementality.FULL_DATASET,
          timestamp: 1000,
        }),
        entity: [
          FeedEntity.create({
            id: 'bus-42',
            vehicle: VehiclePosition.create({
              trip: TripDescriptor.create({ tripId: 'T1' }),
              position: Position.create({ latitude: 47.0, longitude: 24.0 }),
              timestamp: 200,
            }),
          }),
        ],
      });
      return FeedMessage.encode(msg).finish();
    })();
    const bSrc: SourceSnapshot = {
      url: 'https://b/vp.pb',
      role: 'extra',
      bytes: b,
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 1,
    };
    const result = reconcile([a, bSrc]);
    expect(result.entityCount).toBe(1);
    const entities = decodeEntities(result.bytes);
    expect(entities[0]?.ts).toBe(200);
  });

  it('emits entities with empty key as-is (no dedupe, no throw)', () => {
    // A source with one entity that has neither vehicle.vehicle.id
    // nor entity.id. The reconciler cannot dedupe it, so it
    // gets emitted as-is. Better to over-emit than to drop a
    // position the operator paid to send.
    const bytesNoKey = (() => {
      const msg = FeedMessage.create({
        header: FeedHeader.create({
          gtfsRealtimeVersion: '2.0',
          incrementality: FeedHeader.Incrementality.FULL_DATASET,
          timestamp: 1000,
        }),
        entity: [
          FeedEntity.create({
            id: '',
            vehicle: VehiclePosition.create({
              position: Position.create({ latitude: 46.77, longitude: 23.6 }),
              timestamp: 100,
            }),
          }),
        ],
      });
      return FeedMessage.encode(msg).finish();
    })();
    const src: SourceSnapshot = {
      url: 'https://a/vp.pb',
      role: 'primary',
      bytes: bytesNoKey,
      fetchedAt: new Date(),
      appliedAt: new Date(),
      entityCount: 1,
    };
    const result = reconcile([src]);
    expect(result.entityCount).toBe(1);
  });
});
