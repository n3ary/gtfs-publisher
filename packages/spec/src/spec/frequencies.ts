/**
 * GTFS frequencies.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#frequenciestxt
 *
 * Describes intervals between trips for a service period instead of
 * listing exact departure times. Used by the cluj-napoca adapter to
 * collapse the Tranzy headway-based feed into GTFS frequencies rows
 * before merging with the Transitous schedule-based feed.
 *
 * Streaming variant not exported — frequencies.txt is small in
 * practice (one row per trip_id with headway info).
 */
import { z } from 'zod';
import { parseRows } from '../helper/csv-parse.js';

export const FrequenciesRowSchema = z.object({
  /** Required. Trip ID this frequency applies to. */
  trip_id: z.string().min(1),
  /** Required. Start time of the frequency interval (HH:MM:SS). */
  start_time: z.string().min(1),
  /** Required. End time of the frequency interval (HH:MM:SS). */
  end_time: z.string().min(1),
  /** Required. Seconds between departures within the interval. */
  headway_secs: z.string().min(1),
  /** Optional. 0 = frequency-based (default), 1 = exact schedule. */
  exact_times: z.string().optional(),
}).passthrough();

export type FrequenciesRow = z.infer<typeof FrequenciesRowSchema>;

export const parseFrequencies = (text: string): Promise<FrequenciesRow[]> =>
  parseRows(FrequenciesRowSchema, text);