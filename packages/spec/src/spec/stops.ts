/**
 * GTFS stops.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#stopstxt
 *
 * Large feeds (national rail, etc.) can have tens of thousands of rows;
 * use the streaming variant for those.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const StopRowSchema = z.object({
  /** Required. Internal feed-unique identifier. Must be non-empty. */
  stop_id: z.string().min(1),
  /** Optional. Short text or number visible to riders. */
  stop_code: z.string().optional(),
  /** Conditionally required (required if location_type is empty or 0). Name visible to riders. */
  stop_name: z.string().optional(),
  /** Conditionally required (required if location_type is empty or 0). Latitude. */
  stop_lat: z.string().optional(),
  /** Conditionally required (required if location_type is empty or 0). Longitude. */
  stop_lon: z.string().optional(),
  /** Optional. Zone ID. */
  zone_id: z.string().optional(),
  /** Optional. URL of a web page about the stop. */
  stop_url: z.string().optional(),
  /** Optional. Type of location (numeric). */
  location_type: z.string().optional(),
  /** Optional. Station/parent stop ID for entrances/platforms. */
  parent_station: z.string().optional(),
  /** Optional. Timezone of the stop (if it differs from agency). */
  stop_timezone: z.string().optional(),
  /** Optional. 0=unknown, 1=accessible, 2=not accessible. */
  wheelchair_boarding: z.string().optional(),
  /** Optional. Level code for indoor navigation. */
  level_id: z.string().optional(),
  /** Optional. Platform code (e.g. "G"). */
  platform_code: z.string().optional(),
}).passthrough();

export type StopRow = z.infer<typeof StopRowSchema>;

export const parseStops = (text: string): Promise<StopRow[]> => parseRows(StopRowSchema, text);
export const parseStopsStream = (source: AsyncIterable<string>): AsyncIterable<StopRow> =>
  parseRowsStream(StopRowSchema, source);