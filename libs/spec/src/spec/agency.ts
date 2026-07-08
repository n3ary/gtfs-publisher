/**
 * GTFS agency.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#agencytxt
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const AgencyRowSchema = z.object({
  /** Conditionally required (required if more than one row in agency.txt). Internal feed-unique identifier. */
  agency_id: z.string().optional(),
  /** Required. Full name of the transit agency. */
  agency_name: z.string().min(1),
  /** Required. URL of the transit agency. */
  agency_url: z.string().min(1),
  /** Required. Timezone where the transit agency is located. */
  agency_timezone: z.string().min(1),
  /** Optional. Primary language used by this transit agency. */
  agency_lang: z.string().optional(),
  /** Optional. Voice telephone number for the agency. */
  agency_phone: z.string().optional(),
  /** Optional. URL of a web page about fare information. */
  agency_fare_url: z.string().optional(),
  /** Optional. Email address actively monitored by the agency. */
  agency_email: z.string().email().optional(),
}).passthrough();

export type AgencyRow = z.infer<typeof AgencyRowSchema>;

export const parseAgency = (text: string): Promise<AgencyRow[]> => parseRows(AgencyRowSchema, text);
export const parseAgencyStream = (source: AsyncIterable<string>): AsyncIterable<AgencyRow> =>
  parseRowsStream(AgencyRowSchema, source);