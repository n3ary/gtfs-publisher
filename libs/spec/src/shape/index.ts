/**
 * Pure-math shape primitives for projecting GPS points onto a GTFS
 * route shape. Not spec-specific — usable for any great-circle
 * polyline geometry.
 *
 * Why this lives in the package: the consumer (neary) needs this math
 * to render the live map and predict arrivals. Putting it in the
 * shared library means the producer side (gtfs) and consumer
 * side (neary) use the exact same implementation, no drift.
 *
 * Per the issue's cross-repo-math-sharing decision: the producer
 * (gtfs) does not actually need this code right now — it builds
 * the sqlite but doesn't project shapes. But the issue notes the
 * planned RT adapter (step 7+) WILL need it, and the consumer adopts
 * it as step 6. Putting it in the package makes both future
 * consumers' adoption a one-line import.
 */

export type { LatLon } from './latlon.js';
// `DEG` is internal — consumers don't need a degrees-to-radians constant.
export { lerpLatLon, findSegmentAtDistance } from './geometry.js';
export { haversineMeters } from './haversine.js';
export {
  type Polyline,
  type PolylineProjection,
  projectOnPolyline,
  distAlongBetween,
} from './projection.js';
export {
  type MeasuredPolyline,
  measurePolyline,
  pointAtDistance,
} from './measured.js';
export { bearingBetween, bearingAtDistance } from './bearing.js';