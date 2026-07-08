/**
 * GTFS-Realtime feed URL bundle.
 *
 * The "primary" URL slots are a single HTTPS string each. The
 * `extra_vehicle_positions` slot is an array of the same -- used by
 * the rt reconciler when a feed has multiple sources of vehicle
 * positions (e.g. a primary operator RT + a mirror). Trip updates
 * and service alerts have no extra_* slot today; the proxy may
 * add them later if a feed needs them.
 *
 * URLs must be HTTPS (the consumer and CF cache both refuse
 * plain HTTP for transit data).
 */

import { z } from 'zod';

const HttpsUrl = z.string().url().refine(
  (u) => u.startsWith('https://'),
  { message: 'realtime URLs must be https' },
);

export const RealtimeSchema = z.object({
  vehicle_positions: HttpsUrl.optional(),
  extra_vehicle_positions: z.array(HttpsUrl).optional(),
  trip_updates: HttpsUrl.optional(),
  service_alerts: HttpsUrl.optional(),
}).strict();

export type Realtime = z.infer<typeof RealtimeSchema>;