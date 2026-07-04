/**
 * GTFS route_networks.txt reader.
 * https://gtfs.org/schedule/reference/#route_networkstxt
 *
 * The many-to-one join: a route can belong to at most one network per
 * the public spec (PK is `route_id` alone). A feed that emits 1:many
 * rows for the same route is malformed; the static pipeline uses
 * INSERT OR IGNORE on the PK so the first row wins and the rest are
 * dropped silently — a producer concern, surfaced here for reference.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const RouteNetworkRowSchema = z.object({
  /** Foreign ID → networks.network_id. Required. */
  network_id: z.string().min(1),
  /** Foreign ID → routes.route_id. Required. */
  route_id: z.string().min(1),
}).passthrough();

export type RouteNetworkRow = z.infer<typeof RouteNetworkRowSchema>;

export const parseRouteNetworks = (text: string): Promise<RouteNetworkRow[]> => parseRows(RouteNetworkRowSchema, text);
export const parseRouteNetworksStream = (source: AsyncIterable<string>): AsyncIterable<RouteNetworkRow> =>
  parseRowsStream(RouteNetworkRowSchema, source);