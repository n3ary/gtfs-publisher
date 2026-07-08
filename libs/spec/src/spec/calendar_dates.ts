/**
 * GTFS calendar_dates.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#calendar_datestxt
 *
 * Per-date exceptions to the weekly service pattern from calendar.txt.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const CalendarDateRowSchema = z.object({
  /** Required. Service ID referencing calendar.txt (or itself if calendar.txt is absent). */
  service_id: z.string().min(1),
  /** Required. Date of the exception (YYYYMMDD). */
  date: z.string().min(1),
  /** Required. 1=service added, 2=service removed. */
  exception_type: z.string().min(1),
}).passthrough();

export type CalendarDateRow = z.infer<typeof CalendarDateRowSchema>;

export const parseCalendarDates = (text: string): Promise<CalendarDateRow[]> =>
  parseRows(CalendarDateRowSchema, text);
export const parseCalendarDatesStream = (source: AsyncIterable<string>): AsyncIterable<CalendarDateRow> =>
  parseRowsStream(CalendarDateRowSchema, source);