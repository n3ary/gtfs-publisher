/**
 * Great-circle distance on WGS84 mean radius.
 *
 * Used by the shape projection module to compute segment lengths and
 * perpendicular distances. Lives at the package root because it's a
 * fundamental primitive, not spec-specific.
 *
 * Accuracy: ~0.5% at city scale. Fine for the bucketing decisions the
 * shape math uses it for; not for anything where sub-meter matters.
 */

import { DEG } from './geometry.js';

const EARTH_R_M = 6_371_008.8;

/**
 * Great-circle distance between two WGS84 points, in meters.
 *
 * Haversine on a sphere of WGS84 mean radius. Cheaper and more
 * numerically stable than the full Vincenty formula for the short
 * distances that GTFS shape segments span (typically 150-500 m).
 */
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const sa = Math.sin(dLat / 2);
  const so = Math.sin(dLon / 2);
  const c = sa * sa + Math.cos(aLat * DEG) * Math.cos(bLat * DEG) * so * so;
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(c));
}