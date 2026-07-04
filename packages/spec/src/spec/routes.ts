/**
 * GTFS routes.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#routestxt
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const RouteRowSchema = z.object({
  /** Required. Internal feed-unique identifier. */
  route_id: z.string().min(1),
  /** Conditionally required (required if more than one agency in agency.txt). */
  agency_id: z.string().optional(),
  /** Conditionally required (one of short/long name required). Short name visible to riders. */
  route_short_name: z.string().optional(),
  /** Conditionally required. Full name visible to riders. */
  route_long_name: z.string().optional(),
  /** Optional. Description of the route. */
  route_desc: z.string().optional(),
  /** Required. Numeric type (0=tram, 1=subway, 2=rail, 3=bus, ...). */
  route_type: z.string().min(1),
  /** Optional. URL of a web page about the route. */
  route_url: z.string().optional(),
  /** Optional. Hex color (without leading #). */
  route_color: z.string().optional(),
  /** Optional. Hex color for text on the route color. */
  route_text_color: z.string().optional(),
  /** Optional. Sort order within the feed. */
  route_sort_order: z.string().optional(),
  /** Optional. 0=continuous, 1=must phone, 2=must coordinate. */
  continuous_pickup: z.string().optional(),
  /** Optional. Same scheme as continuous_pickup. */
  continuous_drop_off: z.string().optional(),
  /** Optional. Network ID for the route (see networks.txt / route_networks.txt). */
  network_id: z.string().optional(),
}).passthrough();

export type RouteRow = z.infer<typeof RouteRowSchema>;

export const parseRoutes = (text: string): Promise<RouteRow[]> => parseRows(RouteRowSchema, text);
export const parseRoutesStream = (source: AsyncIterable<string>): AsyncIterable<RouteRow> =>
  parseRowsStream(RouteRowSchema, source);