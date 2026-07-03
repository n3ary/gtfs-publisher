/**
 * Shared geometric primitives used by projection, measured-polyline,
 * and bearing math. Lives in its own file so the per-feature modules
 * (projection, measured, bearing) stay focused.
 */

import type { LatLon } from './latlon.js';

/** Radians per degree. Used wherever we need to convert lat/lon
 *  (always in degrees) to/from radians for trig. */
export const DEG = Math.PI / 180;

/** Linear interpolation between two `LatLon` points by parameter `t`.
 *  `t=0` returns `a`; `t=1` returns `b`. Extrapolation is allowed. */
export function lerpLatLon(a: LatLon, b: LatLon, t: number): LatLon {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
  };
}

/**
 * Binary-search `cumDistM` for the segment containing `distM`.
 * Returns the index `lo` of the segment whose cumulative-distance window
 * `[cumDistM[lo], cumDistM[lo + 1])` contains `distM`.
 *
 * Assumes `cumDistM.length >= 2` and `cumDistM` is non-decreasing. The
 * caller is responsible for clamping `distM` to `[0, totalDistM]`
 * before calling (so the returned `lo` is always in range and `lo + 1`
 * is a valid index).
 */
export function findSegmentAtDistance(cumDistM: ReadonlyArray<number>, distM: number): number {
  let lo = 0;
  let hi = cumDistM.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumDistM[mid]! <= distM) lo = mid;
    else hi = mid;
  }
  return lo;
}