/**
 * Build a precomputed-distance index over a polyline.
 *
 * Lets `pointAtDistance` resolve a position in O(log n) via binary
 * search instead of re-walking the line on every render tick.
 */

import { haversineMeters } from './haversine.js';
import type { LatLon } from './latlon.js';
import type { Polyline } from './projection.js';
import { findSegmentAtDistance, lerpLatLon } from './geometry.js';

export interface MeasuredPolyline {
  points: Polyline;
  /** `cumDistM[i]` = distance from points[0] to points[i] along the
   *  polyline, in meters. `cumDistM[0]` is 0; `cumDistM[length-1]`
   *  equals `totalDistM`. */
  cumDistM: number[];
  totalDistM: number;
}

/** Build the cumulative-distance index for a polyline. O(n). */
export function measurePolyline(polyline: Polyline): MeasuredPolyline {
  const n = polyline.length;
  const cumDistM = new Array<number>(n);
  if (n === 0) return { points: polyline, cumDistM, totalDistM: 0 };
  cumDistM[0] = 0;
  for (let i = 1; i < n; i++) {
    cumDistM[i]! = cumDistM[i - 1]! + haversineMeters(
      polyline[i - 1]!.lat, polyline[i - 1]!.lon,
      polyline[i]!.lat,     polyline[i]!.lon,
    );
  }
  return { points: polyline, cumDistM, totalDistM: cumDistM[n - 1]! };
}

/** Resolve a cumulative-distance value back to a lat/lon on the
 *  polyline. Clamps to the endpoints when out of range. O(log n)
 *  thanks to the precomputed `cumDistM`.
 *
 * Edge cases (intentional precedence):
 *   - length 0         → throws (programming error in the caller)
 *   - length 1         → returns the single point (regardless of distM)
 *   - distM < 0        → returns the start vertex
 *   - distM > total    → returns the end vertex
 *
 * When length === 1, totalDistM === 0, so both the "distM <= 0" and
 * "distM >= totalDistM" branches would match; the "length 1 OR distM <= 0"
 * check above wins and returns the single point. */
export function pointAtDistance(measured: MeasuredPolyline, distM: number): LatLon {
  const { points, cumDistM, totalDistM } = measured;
  if (points.length === 0) {
    throw new Error('pointAtDistance: empty polyline');
  }
  if (points.length === 1 || distM <= 0) return points[0]!;
  if (distM >= totalDistM) return points[points.length - 1]!;
  const lo = findSegmentAtDistance(cumDistM, distM);
  // noUncheckedIndexedAccess; findSegmentAtDistance guarantees lo+1 < n.
  const a = points[lo]!;
  const b = points[lo + 1]!;
  const segLen = cumDistM[lo + 1]! - cumDistM[lo]!;
  const t = segLen > 0 ? (distM - cumDistM[lo]!) / segLen : 0;
  return lerpLatLon(a, b, t);
}