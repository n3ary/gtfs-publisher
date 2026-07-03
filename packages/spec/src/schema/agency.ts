/**
 * GTFS agency.txt spec — one row per agency operating transit service
 * in a feed. See https://gtfs.org/documentation/schedule/reference/#agencytxt
 */

import { z } from 'zod';

export const AgencySchema = z.object({
  /** Required. Full name of the transit agency. */
  agency_name: z.string().min(1),
  /** Optional. Internal feed-unique identifier. */
  agency_id: z.string().nullable().default(null),
  /** Optional. URL of the transit agency. */
  agency_url: z.string().url().nullable().default(null),
}).strict();

export type Agency = z.infer<typeof AgencySchema>;