/**
 * rt.ts -- zod schema for the GTFS-Realtime FeedMessage body.
 *
 * Validates the PROTOBUF-DECODED shape (the in-memory JS object that
 * `gtfs-realtime-bindings` returns after `FeedMessage.decode(buf)`).
 * Used by the rt app after the per-feed adapter applies its quirk,
 * so we can reject malformed output before re-encode + serve.
 *
 * Scope is intentionally minimal -- shapes + lat/lon bounds only.
 * Field-level semantics (correct trip_id format, sane dwell times,
 * presence of trip descriptor on a vehicle) belong in the per-feed
 * adapter; we just gate "this looks like a valid GTFS-RT message".
 *
 * Two non-obvious adjustments vs. a hand-rolled schema:
 *
 *   1. We do NOT use `.strict()`. Protobufjs encodes the underlying
 *      message as a plain JS object AND attaches a `.toJSON()`
 *      method on every nested object for `JSON.stringify` callers.
 *      A strict zod schema would reject the message solely because
 *      it has a `toJSON` property. `.passthrough()` lets extra
 *      fields (like `startDate`, `odometer`) and the `toJSON`
 *      method through without complaint.
 *
 *   2. Numeric fields (`timestamp`, `congestionLevel`, etc.) are
 *      typed `z.any()` because protobufjs surfaces uint64 values
 *      as either plain `number`, `Long`, or `bigint` depending on
 *      magnitude + runtime. Validating "is a number" reliably
 *      across all three requires custom coercion; not in scope for
 *      the minimal gate.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// Primitives

const LatRange    = z.number().min(-90).max(90);
const LonRange    = z.number().min(-180).max(180);
const BearingRange = z.number().min(0).max(360);

// Numeric field whose underlying protobuf type is uint64 / int32 /
// enum. Type-flexible so protobufjs's `Long`/`bigint`/`number`
// variants all pass.
const NumField = z.any().optional();

// ─────────────────────────────────────────────────────────────────────────
// Entity sub-shapes (passthrough; no .strict())

const Position = z.object({
  latitude:   LatRange.optional(),
  longitude:  LonRange.optional(),
  bearing:    BearingRange.optional(),
  speed:      z.number().nonnegative().optional(),
}).passthrough();

const TripDescriptor = z.object({
  tripId:     z.string().min(1).optional(),
  routeId:    z.string().min(1).optional(),
  directionId: z.union([z.literal(0), z.literal(1)]).optional(),
  // startTime format varies across feeds (HH:MM:SS, HH:MM, empty
  // string for "not populated", or past-midnight 24+:MM:SS). We just
  // gate it as a string; downstream consumers validate the specific
  // format they care about. Regex here was over-strict.
  startTime:  z.string().optional(),
  scheduleRelationship: NumField,
}).passthrough();

/**
 * VehicleDescriptor is optional in the proto; we don't enforce it
 * (a feed can identify the entity purely by `entity.id`).
 */
const VehicleDescriptor = z.object({
  id:           z.string().optional(),
  label:        z.string().optional(),
  licensePlate: z.string().optional(),
}).passthrough();

const VehiclePosition = z.object({
  trip:                TripDescriptor.optional(),
  position:            Position.optional(),
  currentStopSequence: NumField,
  stopId:              z.string().optional(),
  currentStatus:       NumField,
  timestamp:           NumField,
  congestionLevel:     NumField,
  occupancyStatus:     NumField,
  vehicle:             VehicleDescriptor.optional(),
}).passthrough();

const FeedEntity = z.object({
  id:        z.string().min(1),
  isDeleted: z.boolean().optional(),
  // The other shapes (TripUpdate, Alert) are handled by other
  // endpoints; we don't decode them on this path.
  vehicle:   VehiclePosition.optional(),
}).passthrough();

const FeedHeader = z.object({
  gtfsRealtimeVersion: z.string().min(1),
  incrementality:      NumField,
  timestamp:           NumField,
}).passthrough();

// ─────────────────────────────────────────────────────────────────────────
// Top-level

export const FeedMessageSchema = z.object({
  header: FeedHeader,
  entity: z.array(FeedEntity),
}).passthrough();

export type FeedMessageT = z.infer<typeof FeedMessageSchema>;
export type VehiclePositionT = z.infer<typeof VehiclePosition>;
export type FeedEntityT = z.infer<typeof FeedEntity>;
