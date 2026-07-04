/**
 * GTFS networks.txt reader.
 * https://gtfs.org/schedule/reference/#networkstxt
 *
 * networks.txt is Conditionally Forbidden: a feed either ships
 * networks.txt + route_networks.txt as a pair, or neither. networks
 * group routes for fare rules, modal grouping, and per-network UI
 * styling on the consumer side.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const NetworkRowSchema = z.object({
  /** Required. Internal feed-unique identifier. Must be unique in networks.txt. */
  network_id: z.string().min(1),
  /** Optional. The name of the network as used by the local agency and its riders. */
  network_name: z.string().optional(),
}).passthrough();

export type NetworkRow = z.infer<typeof NetworkRowSchema>;

export const parseNetworks = (text: string): Promise<NetworkRow[]> => parseRows(NetworkRowSchema, text);
export const parseNetworksStream = (source: AsyncIterable<string>): AsyncIterable<NetworkRow> =>
  parseRowsStream(NetworkRowSchema, source);