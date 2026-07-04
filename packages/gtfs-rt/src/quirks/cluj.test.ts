/**
 * cluj.test.ts — unit test for the Cluj quirk.
 *
 * Covers:
 *   - pattern match → direction_id + start_time recovered
 *   - direction_id=0 + start_time empty → recovered
 *   - direction_id=1 + start_time set → untouched (already correct)
 *   - trip_id not matching the pattern → untouched
 *   - parseClujTripId pure-function output
 */
import { describe, it, expect } from 'vitest';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { clujQuirk, parseClujTripId } from './cluj.js';

function makeEntity(tripId: string, directionId: number, startTime: string) {
  return GtfsRealtimeBindings.transit_realtime.FeedEntity.create({
    id: 'e1',
    vehicle: GtfsRealtimeBindings.transit_realtime.VehiclePosition.create({
      trip: GtfsRealtimeBindings.transit_realtime.TripDescriptor.create({
        tripId,
        directionId,
        startTime,
      }),
    }),
  });
}

function makeMessage(entity: ReturnType<typeof makeEntity>) {
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.create({
    header: GtfsRealtimeBindings.transit_realtime.FeedHeader.create({
      gtfsRealtimeVersion: '2.0',
      incrementality: GtfsRealtimeBindings.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
    }),
    entity: [entity],
  });
}

describe('parseClujTripId', () => {
  it('parses a well-formed id', () => {
    const out = parseClujTripId('38_0_weekday_2_1430');
    expect(out).toEqual({
      routeId: '38',
      dirId: 0,
      serviceId: 'weekday',
      run: 2,
      startTime: '14:30:00',
    });
  });

  it('returns null on a non-matching id', () => {
    expect(parseClujTripId('not-a-cluj-id')).toBeNull();
    expect(parseClujTripId('')).toBeNull();
  });
});

describe('clujQuirk', () => {
  it('recovers direction_id + start_time when upstream is wrong', () => {
    const msg = makeMessage(makeEntity('38_0_weekday_2_1430', 0, ''));
    const out = clujQuirk(msg, {} as never);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(0);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('14:30:00');
  });

  it('leaves already-correct entities alone', () => {
    const msg = makeMessage(makeEntity('38_0_weekday_2_1430', 1, '14:30:00'));
    const out = clujQuirk(msg, {} as never);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(1);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('14:30:00');
  });

  it('leaves unparseable trip_ids alone', () => {
    const msg = makeMessage(makeEntity('weird-trip-id', 0, ''));
    const out = clujQuirk(msg, {} as never);
    expect(out.entity[0]!.vehicle!.trip!.directionId).toBe(0);
    expect(out.entity[0]!.vehicle!.trip!.startTime).toBe('');
  });
});
