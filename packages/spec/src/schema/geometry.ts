/**
 * Geometric / temporal primitives the GTFS-derived registry metadata
 * needs. Not directly from the GTFS spec — these are derived from
 * `stops.txt`, `agency.txt`, and `feed_info.txt` by the static pipeline.
 */

import { z } from 'zod';

/** Bounding box of a feed's stops, rounded to 5 decimal places (~1 m). */
export const BboxSchema = z.object({
  minLat: z.number().min(-90).max(90),
  minLon: z.number().min(-180).max(180),
  maxLat: z.number().min(-90).max(90),
  maxLon: z.number().min(-180).max(180),
}).strict();

export type Bbox = z.infer<typeof BboxSchema>;

/** Midpoint of a feed's bounding box. */
export const CenterSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
}).strict();

export type Center = z.infer<typeof CenterSchema>;

/** ISO 8601 calendar date (YYYY-MM-DD) or null if the source didn't specify. */
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').nullable();

/** Validity window derived from `feed_info.txt`. */
export const ValiditySchema = z.object({
  from: IsoDate,
  until: IsoDate,
}).strict();

export type Validity = z.infer<typeof ValiditySchema>;