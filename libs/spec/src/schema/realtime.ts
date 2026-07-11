/**
 * GTFS-Realtime feed URL bundle.
 *
 * Two URL slots for `vehicle_positions`:
 *   - `upstream_vehicle_positions` -- the URL the new gtfs-rt server
 *     polls. Auto-filled from the MDB catalog by the static pipeline;
 *     per-feed config can override. This is "what we read".
 *   - `vehicle_positions` -- the URL consumers call. When a feed
 *     has a `feeds/<id>/config.json`, the static pipeline rewrites
 *     this to the canonical `gtfs-rt.n3ary.com/rt/<id>/vehicle_positions`
 *     (the new server). This is "what the app reads".
 *
 * The two-field split avoids a circular dependency: the new server
 * reads `feeds.json` to know what to poll, and the app reads the
 * same `feeds.json` to know what to call. If both pointed at the
 * same URL, the server would poll itself.
 *
 * `extra_vehicle_positions` is an array of the same shape -- used
 * by the gtfs-rt server's poller when a feed has additional streams
 * (operator mirrors, community backups, etc.) the operator controls
 * via the per-feed config. Today the server polls + stores these
 * but only the primary URL is exposed via `/rt/<feed>/vehicle_positions`;
 * reconciliation lands in a follow-up PR.
 *
 * Trip updates and service alerts have no extra_* slot today; the
 * proxy may add them later if a feed needs them.
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
  /** URL the consumer (app) calls for cleaned vehicle_positions. */
  vehicle_positions: HttpsUrl.optional(),
  /** URL the gtfs-rt server polls. MDB-derived by default. */
  upstream_vehicle_positions: HttpsUrl.optional(),
  /** Additional vehicle_positions streams the operator controls. */
  extra_vehicle_positions: z.array(HttpsUrl).optional(),
  trip_updates: HttpsUrl.optional(),
  service_alerts: HttpsUrl.optional(),
}).strict();

export type Realtime = z.infer<typeof RealtimeSchema>;