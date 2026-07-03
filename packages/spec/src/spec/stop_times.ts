/**
 * GTFS stop_times.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#stop_timestxt
 *
 * stop_times.txt is the largest file in most feeds (60-90% of the
 * GTFS-by-size footprint on national rail networks, often >500 MB
 * uncompressed). Always use the streaming variant.
 */

import { z } from 'zod';
import { parseRowsStream } from '../helper/csv-parse.js';

export const StopTimeRowSchema = z.object({
  /** Required. Trip ID referencing trips.txt. */
  trip_id: z.string().min(1),
  /** Required. Arrival time at the stop (HH:MM:SS). May exceed 24:00:00. */
  arrival_time: z.string().min(1),
  /** Required. Departure time from the stop (HH:MM:SS). */
  departure_time: z.string().min(1),
  /** Required. Stop ID referencing stops.txt. */
  stop_id: z.string().min(1),
  /** Required. Order of stops for a particular trip. Monotonically increasing per trip. */
  stop_sequence: z.string().min(1),
  /** Optional. Text visible to riders for the stop. */
  stop_headsign: z.string().optional(),
  /** Optional. 0=regular, 1=no pickup, 2=must phone, 3=must coordinate. */
  pickup_type: z.string().optional(),
  /** Optional. Same scheme as pickup_type. */
  drop_off_type: z.string().optional(),
  /** Optional. Continuous pickup behavior. */
  continuous_pickup: z.string().optional(),
  /** Optional. Continuous drop-off behavior. */
  continuous_drop_off: z.string().optional(),
  /** Optional. Distance along the shape (units depend on feed). */
  shape_dist_traveled: z.string().optional(),
  /** Optional. 0=approximate, 1=exact. */
  timepoint: z.string().optional(),
}).passthrough();

export type StopTimeRow = z.infer<typeof StopTimeRowSchema>;

/**
 * Streaming-only. {@link parseStopTimes} is intentionally not exported
 * — synchronously loading 500+ MB into a string blows Node's v8
 * kMaxLength (~512 MB).
 */
export const parseStopTimesStream = (source: AsyncIterable<string>): AsyncIterable<StopTimeRow> =>
  parseRowsStream(StopTimeRowSchema, source);