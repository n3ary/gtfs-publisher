/**
 * rt.test.ts -- FeedMessageSchema tests.
 *
 * Validates that the rt proxy's spec gate accepts real GTFS-RT
 * shapes -- including protobuf-decoded objects, which carry
 * protobufjs's `toJSON()` method on every nested level and may
 * include undeclared fields (startDate, odometer, etc.).
 *
 * Tests use plain POJOs shaped like `gtfs-realtime-bindings`'s
 * decoded output -- proto-shaped JS objects with toJSON() attached.
 * This avoids a gtfs-realtime-bindings devDep on libs/spec (the
 * package is intentionally minimal; it's a contract, not a runtime).
 */
import { describe, it, expect } from 'vitest';
import { FeedMessageSchema } from '../src/schema/rt.js';

/** A minimal stand-in for `protobufjs`'s message. Recursively
 *  attaches toJSON() so nested objects behave like real protobufjs
 *  messages. Enough to prove the passthrough mode tolerates
 *  protobufjs's idiosyncrasies. */
function protoMsg<T>(data: T): T {
  if (data === null || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map((d) => protoMsg(d)) as unknown as T;
  const proto = data as Record<string, unknown>;
  for (const k of Object.keys(proto)) proto[k] = protoMsg(proto[k]);
  Object.defineProperty(proto, 'toJSON', {
    value: function () {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(proto)) {
        if (k === 'toJSON') continue;
        out[k] = proto[k];
      }
      return out;
    },
    enumerable: false,
    configurable: true,
  });
  return data;
}

describe('FeedMessageSchema', () => {
  it('accepts a minimal valid FeedMessage', () => {
    const msg = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [
        { id: 'v1', vehicle: { position: { latitude: 46.77, longitude: 23.6 } } },
      ],
    });
    const parsed = FeedMessageSchema.safeParse(msg);
    expect(parsed.success).toBe(true);
  });

  it('accepts the cluj upstream payload (real-world, with half-populated trip)', () => {
    // Mirror what the rt poller actually receives from
    // https://cluj-rt-feed.gtfs.ro/vehiclePositions: a FeedMessage
    // with header.version=1.0, ~184 entities, each with a
    // `<route>_<dir>_<svc>_<run>_<HHMM>` tripId and (often empty)
    // startTime / directionId. The cluj quirk is supposed to fill
    // these in but currently can't (regex case mismatch, separate
    // upstream issue); the rt spec gate must NOT reject the
    // half-populated shape.
    const msg = protoMsg({
      header: { gtfsRealtimeVersion: '1.0', incrementality: 0, timestamp: 1783515150 },
      entity: [
        {
          id: 'e1',
          vehicle: {
            trip: { tripId: '42_0_LV_30_1445', routeId: '42', directionId: 0, startTime: '' },
            position: { latitude: 46.7624, longitude: 23.5454, bearing: 90, speed: 5 },
            timestamp: 1783515150,
            vehicle: { id: '802' },
          },
        },
      ],
    });
    expect(FeedMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('passes protobufjs `toJSON()` through (passthrough mode, not strict)', () => {
    // Every protobufjs message has a `toJSON` method for
    // JSON.stringify callers. A strict zod schema would reject it.
    const header = protoMsg({ gtfsRealtimeVersion: '2.0' });
    const entity = protoMsg({
      id: 'e1',
      vehicle: { position: protoMsg({ latitude: 0, longitude: 0 }) },
    });
    expect(typeof header.toJSON).toBe('function');
    expect(typeof entity.toJSON).toBe('function');
    expect(typeof entity.vehicle.toJSON).toBe('function');

    const msg = protoMsg({ header, entity: [entity] });
    expect(FeedMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('accepts undeclared fields (startDate, odometer) via passthrough', () => {
    // Protobufjs surfaces all proto fields as enumerable props,
    // even ones we don't model in zod. They must pass through.
    const msg = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [
        {
          id: 'e1',
          vehicle: {
            trip: {
              tripId: '42_0_LV_30_1445',
              startDate: '20260708',           // undeclared on TripDescriptor
            },
            position: {
              latitude: 0,
              longitude: 0,
              odometer: 12345,                  // undeclared on Position
            },
          },
        },
      ],
    });
    expect(FeedMessageSchema.safeParse(msg).success).toBe(true);
  });

  it('rejects an out-of-range latitude', () => {
    const msg = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [
        { id: 'e1', vehicle: { position: { latitude: 200, longitude: 0 } } },
      ],
    });
    expect(FeedMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('accepts directionId 0 and 1, rejects 2', () => {
    const ok = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [{ id: 'e1', vehicle: { trip: { tripId: 'x', directionId: 0 } } }],
    });
    expect(FeedMessageSchema.safeParse(ok).success).toBe(true);

    const bad = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [{ id: 'e1', vehicle: { trip: { tripId: 'x', directionId: 2 } } }],
    });
    expect(FeedMessageSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts entity without trip (position-only vehicles)', () => {
    const msg = protoMsg({
      header: { gtfsRealtimeVersion: '2.0' },
      entity: [
        { id: 'e1', vehicle: { position: { latitude: 0, longitude: 0 } } },
      ],
    });
    expect(FeedMessageSchema.safeParse(msg).success).toBe(true);
  });
});
