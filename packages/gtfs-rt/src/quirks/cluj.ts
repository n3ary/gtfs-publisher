/**
 * Cluj quirk — recover `direction_id` and `start_time` from the
 * upstream's `<route>_<dir>_<service>_<run>_<HHMM>`-encoded
 * `trip_id`. See n3ary/app#161 for the full context.
 *
 * Why this lives in the producer and not the consumer: the encoded
 * trip_id is per-feed knowledge. The Cluj upstream publishes
 * `direction_id=0` for every vehicle and an empty `start_time` —
 * recoverable only if you know the encoding. Keeping it here means
 * the consumer (n3ary/app) stays strictly feed-agnostic.
 *
 * Encoding (from the upstream):
 *   <route_id>_<dir_id>_<service_id>_<run>_<HHMM>
 *     e.g. "38_0_weekday_2_1430"
 *           route=38, dir=0, service=weekday, run=2, start=14:30
 *
 * If a trip_id doesn't match this pattern, it's left as-is — we'd
 * rather pass through an unknown case than guess and mis-attribute.
 */
import type GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { Quirk } from './types.js';

type FeedMessage = GtfsRealtimeBindings.transit_realtime.FeedMessage;

const PATTERN = /^(\d+)_(\d)_([a-z0-9]+)_(\d+)_(\d{4})$/;

/**
 * Parse a Cluj-encoded trip_id. Returns null if the format doesn't
 * match. Exported for unit testing.
 */
export function parseClujTripId(
  tripId: string,
): { routeId: string; dirId: number; serviceId: string; run: number; startTime: string } | null {
  const m = PATTERN.exec(tripId);
  if (!m) return null;
  const routeId = m[1] ?? '';
  const dir = m[2] ?? '';
  const serviceId = m[3] ?? '';
  const run = m[4] ?? '';
  const hhmm = m[5] ?? '';
  return {
    routeId,
    dirId: Number(dir),
    serviceId,
    run: Number(run),
    startTime: `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00`,
  };
}

export const clujQuirk: Quirk = (feedMessage: FeedMessage) => {
  for (const entity of feedMessage.entity) {
    if (!entity.vehicle) continue;
    const trip = entity.vehicle.trip;
    if (!trip || !trip.tripId) continue;

    // Only touch trips where the upstream clearly failed the spec
    // (direction_id=0 on every vehicle, empty start_time). If the
    // upstream has populated these correctly, leave them alone.
    const dirIsZero = trip.directionId === 0;
    const startTimeEmpty = !trip.startTime || trip.startTime === '';
    if (!dirIsZero && !startTimeEmpty) continue;

    const parsed = parseClujTripId(trip.tripId);
    if (!parsed) continue;

    if (dirIsZero) trip.directionId = parsed.dirId;
    if (startTimeEmpty) trip.startTime = parsed.startTime;
  }
  return feedMessage;
};
