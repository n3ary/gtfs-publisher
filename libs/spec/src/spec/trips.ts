/**
 * GTFS trips.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#tripstxt
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const TripRowSchema = z.object({
  /** Required. Internal feed-unique identifier. */
  trip_id: z.string().min(1),
  /** Conditionally required (required if more than one route in routes.txt). */
  route_id: z.string().optional(),
  /** Required. Service ID referencing calendar.txt or calendar_dates.txt. */
  service_id: z.string().min(1),
  /** Optional. Text visible to riders identifying the trip's destination. */
  trip_headsign: z.string().optional(),
  /** Optional. Text visible to riders for sub-names. */
  trip_short_name: z.string().optional(),
  /** Optional. 0 or 1 indicating direction. */
  direction_id: z.string().optional(),
  /** Optional. Block ID for trip chaining. */
  block_id: z.string().optional(),
  /** Conditionally required (required if shapes.txt is provided). Shape ID. */
  shape_id: z.string().optional(),
  /** Optional. 0=unknown, 1=accessible, 2=not accessible. */
  wheelchair_accessible: z.string().optional(),
  /** Optional. 0=unknown, 1=allowed, 2=not allowed. */
  bikes_allowed: z.string().optional(),
}).passthrough();

export type TripRow = z.infer<typeof TripRowSchema>;

export const parseTrips = (text: string): Promise<TripRow[]> => parseRows(TripRowSchema, text);
export const parseTripsStream = (source: AsyncIterable<string>): AsyncIterable<TripRow> =>
  parseRowsStream(TripRowSchema, source);