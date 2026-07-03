/**
 * GTFS-Realtime feed URL bundle. Mirrors the three entity types a
 * GTFS-RT source can publish: vehicle positions, trip updates, and
 * service alerts. URLs may be absent — most feeds ship a subset.
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
  trip_updates: HttpsUrl.optional(),
  service_alerts: HttpsUrl.optional(),
}).strict();

export type Realtime = z.infer<typeof RealtimeSchema>;