/**
 * GTFS calendar.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#calendartxt
 *
 * Defines weekly service patterns keyed by service_id.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const CalendarRowSchema = z.object({
  /** Required. Internal feed-unique identifier referenced by trips.txt. */
  service_id: z.string().min(1),
  /** Required. 1 if the service runs on Mondays, 0 otherwise. */
  monday: z.string().min(1),
  /** Required. Same scheme as monday. */
  tuesday: z.string().min(1),
  /** Required. Same scheme as monday. */
  wednesday: z.string().min(1),
  /** Required. Same scheme as monday. */
  thursday: z.string().min(1),
  /** Required. Same scheme as monday. */
  friday: z.string().min(1),
  /** Required. Same scheme as monday. */
  saturday: z.string().min(1),
  /** Required. Same scheme as monday. */
  sunday: z.string().min(1),
  /** Required. Service start date (YYYYMMDD). */
  start_date: z.string().min(1),
  /** Required. Service end date (YYYYMMDD). */
  end_date: z.string().min(1),
}).passthrough();

export type CalendarRow = z.infer<typeof CalendarRowSchema>;

export const parseCalendar = (text: string): Promise<CalendarRow[]> => parseRows(CalendarRowSchema, text);
export const parseCalendarStream = (source: AsyncIterable<string>): AsyncIterable<CalendarRow> =>
  parseRowsStream(CalendarRowSchema, source);

/**
 * GTFS calendar.txt day-of-week column names, in GTFS week order
 * (Monday = 0, Sunday = 6). Consumers index with `(date.getDay() + 6) % 7`
 * to convert from `Date.getDay()`'s Sunday-first ordering.
 *
 * Exported as a `readonly` tuple so consumers get the exact literal
 * type, not just `string[]` — that lets queries parameterise on
 * `keyof CalendarRowSchema['shape']` etc.
 */
export const DAY_KEY_COLS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type DayKey = (typeof DAY_KEY_COLS)[number];