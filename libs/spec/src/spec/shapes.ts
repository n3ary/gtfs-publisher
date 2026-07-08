/**
 * GTFS shapes.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#shapestxt
 *
 * shapes.txt describes the path a vehicle follows along a route. Like
 * stop_times.txt, this file routinely exceeds 500 MB uncompressed on
 * national feeds — always use the streaming variant.
 */

import { z } from 'zod';
import { parseRowsStream } from '../helper/csv-parse.js';

export const ShapeRowSchema = z.object({
  /** Required. Internal feed-unique identifier. */
  shape_id: z.string().min(1),
  /** Required. Latitude of a shape point. */
  shape_pt_lat: z.string().min(1),
  /** Required. Longitude of a shape point. */
  shape_pt_lon: z.string().min(1),
  /** Required. Sequence of the point along the shape (monotonically increasing per shape_id). */
  shape_pt_sequence: z.string().min(1),
  /** Optional. Distance traveled along the shape from the first point. */
  shape_dist_traveled: z.string().optional(),
}).passthrough();

export type ShapeRow = z.infer<typeof ShapeRowSchema>;

/**
 * Streaming-only. {@link parseShapes} is intentionally not exported
 * — synchronously loading shapes.txt into a single string blows Node's
 * v8 kMaxLength (~512 MB) on national feeds.
 */
export const parseShapesStream = (source: AsyncIterable<string>): AsyncIterable<ShapeRow> =>
  parseRowsStream(ShapeRowSchema, source);