/**
 * polyline — pure geometry helpers for projecting points onto a GTFS
 * route shape and measuring cumulative distance along it.
 *
 * Mirrors the runtime version in
 * neary/src/lib/domain/shapeProjection.ts; kept here as a separate
 * vendored copy because pipeline scripts are plain Node and don't
 * share the app's TypeScript build setup. Same math, no DOM, no I/O.
 *
 * Used by the Cluj enhancement build to walk each trip's
 * `stop_sequence` along its `shape_id` polyline so stop-to-stop
 * distances reflect the road, not crow-flight haversine.
 */

const R_EARTH_M = 6_371_000;

/** Great-circle distance in meters between two lat/lon points. */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R_EARTH_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Project a single point onto the closest segment of a polyline.
 * Returns the cumulative distance along the polyline at the
 * projection (`distAlongM`) and the perpendicular distance from the
 * input point to the polyline (`perpDistM`).
 *
 * Per-segment math uses an equirectangular linearization anchored on
 * each segment's first vertex; segment lengths are computed exactly
 * with haversine so meter values are not skewed.
 *
 * Throws on a polyline of fewer than 2 points — callers must guard.
 *
 * @param {{lat:number,lon:number}} point
 * @param {Array<{lat:number,lon:number}>} polyline
 * @returns {{distAlongM:number, perpDistM:number, segmentIdx:number}}
 */
export function projectOnPolyline(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length < 2) {
    throw new Error('projectOnPolyline: polyline must have at least 2 points');
  }
  let bestPerpM = Infinity;
  let bestSegmentIdx = 0;
  let bestDistAlongM = 0;
  let runningCumDistM = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segLenM = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    const { t, perpM } = projectOnSegment(point, a, b, segLenM);
    if (perpM < bestPerpM) {
      bestPerpM = perpM;
      bestSegmentIdx = i;
      bestDistAlongM = runningCumDistM + t * segLenM;
    }
    runningCumDistM += segLenM;
  }

  return { distAlongM: bestDistAlongM, perpDistM: bestPerpM, segmentIdx: bestSegmentIdx };
}

function projectOnSegment(p, a, b, segLenM) {
  if (segLenM === 0) {
    return { t: 0, perpM: haversineMeters(p.lat, p.lon, a.lat, a.lon) };
  }
  const cosLat = Math.cos((a.lat * Math.PI) / 180);
  const ax = a.lon * cosLat;
  const ay = a.lat;
  const bx = b.lon * cosLat;
  const by = b.lat;
  const px = p.lon * cosLat;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const tRaw = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  const projLat = ay + t * dy;
  const projLon = (ax + t * dx) / cosLat;
  const perpM = haversineMeters(p.lat, p.lon, projLat, projLon);
  return { t, perpM };
}

/**
 * Project each stop in `stops` onto the polyline and return their
 * cumulative distances along the shape, in input order.
 *
 * To prevent a stop that projects slightly upstream of its
 * predecessor (e.g. when two adjacent stops both lie near the same
 * polyline kink) from producing a negative segment length, the
 * returned values are monotonically non-decreasing — each entry is
 * `max(projection, previous + 1)`.
 *
 * Falls back to haversine-between-adjacent-stops when the polyline
 * is missing / too short / when a stop's perpendicular distance
 * exceeds `maxPerpDistM` (the stop isn't on this shape). The
 * fallback also seeds the cumulative distance with the projection
 * for stops that DID project well, so a single off-shape stop
 * doesn't poison the whole trip.
 *
 * @param {Array<{lat:number,lon:number}>} stops  ordered by stop_sequence
 * @param {Array<{lat:number,lon:number}>} polyline  may be empty
 * @param {number} maxPerpDistM  threshold above which a projection is rejected
 * @returns {number[]}  cumulative distance per stop, in meters
 */
export function cumulativeShapeDistances(stops, polyline, maxPerpDistM = 200) {
  const n = stops.length;
  if (n === 0) return [];
  const usable = Array.isArray(polyline) && polyline.length >= 2;
  const out = new Array(n);
  if (!usable) {
    out[0] = 0;
    for (let i = 1; i < n; i++) {
      out[i] = out[i - 1] + haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const { distAlongM, perpDistM } = projectOnPolyline(stops[i], polyline);
    const fallback = i === 0
      ? 0
      : out[i - 1] + haversineMeters(stops[i - 1].lat, stops[i - 1].lon, stops[i].lat, stops[i].lon);
    let chosen = perpDistM > maxPerpDistM ? fallback : distAlongM;
    if (i > 0 && chosen <= out[i - 1]) chosen = out[i - 1] + 1;
    out[i] = chosen;
  }
  return out;
}
