/**
 * Initial bearing between two WGS84 points, and the bearing of a
 * polyline at a given cumulative distance.
 *
 * Bearings are in degrees clockwise from North (0 = N, 90 = E).
 */

import type { LatLon } from './latlon.js';
import type { MeasuredPolyline } from './measured.js';
import { DEG, findSegmentAtDistance } from './geometry.js';

/** Initial great-circle bearing from point `a` to point `b`, in
 *  degrees CW from North (0 = North, 90 = East). */
export function bearingBetween(a: LatLon, b: LatLon): number {
  const f1 = a.lat * DEG;
  const f2 = b.lat * DEG;
  const dl = (b.lon - a.lon) * DEG;
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Bearing in degrees (0 = North, 90 = East) of the segment that
 *  contains the given cumulative distance. Used to rotate direction
 *  arrows on the route map so they point the way the vehicle is
 *  travelling. */
export function bearingAtDistance(measured: MeasuredPolyline, distM: number): number {
  const { points, cumDistM, totalDistM } = measured;
  if (points.length < 2) return 0;
  const clamped = Math.max(0, Math.min(totalDistM, distM));
  const lo = findSegmentAtDistance(cumDistM, clamped);
  // noUncheckedIndexedAccess; early-return guarantees lo+1 < points.length.
  const a = points[lo]!;
  const b = points[lo + 1] ?? a;
  return bearingBetween(a, b);
}