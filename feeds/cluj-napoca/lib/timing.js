/**
 * timing — pure helpers that turn a trip's origin departure time +
 * its ordered stop list into per-stop arrival/departure seconds
 * since midnight + shape_dist_traveled values.
 *
 * Three improvements over the legacy haversine-with-clamps approach:
 *
 *   1. Shape-aware distance. Stop positions are projected onto the
 *      route's polyline (when present), so distances reflect what
 *      the bus actually drives instead of crow-flight.
 *
 *   2. Time-of-day speed bucket. Average speed is picked from a
 *      config table (`peak` / `offpeak` / `night`) based on the
 *      trip's origin departure time. Rush-hour trips no longer get
 *      the same 18 km/h estimate as 03:00 night trips.
 *
 *   3. Intermediate-stop dwell. Every non-origin / non-terminus
 *      stop gets a small fixed dwell (default 20 s) so the
 *      generated `arrival_time` and `departure_time` actually
 *      differ — matching how operators publish their timetables
 *      and giving the bucketer a meaningful "at-station" window.
 *
 * Pure. No I/O.
 */

import { cumulativeShapeDistances } from '../../../src/pipeline/lib/polyline.js';

/** Parse "HH:MM" or "HH:MM:SS" into minutes since midnight. */
function hhmmToMin(hhmm) {
  const parts = hhmm.split(':').map(Number);
  return parts[0] * 60 + (parts[1] ?? 0);
}

/**
 * Pick the average speed bucket for a trip whose origin departure
 * is at `originMinOfDay` (0..1439). Bucket precedence:
 *
 *   1. `night` (wraps midnight, e.g. 22:30 → 05:30)
 *   2. `peak`  (any of the listed windows on the day)
 *   3. `offpeak` (the default)
 *
 * @param {number} originMinOfDay  minutes since 00:00, may be ≥ 1440 for post-midnight
 * @param {{
 *   speedKmh: {peak:number, offpeak:number, night:number},
 *   peakWindows: Array<{from:string, to:string}>,
 *   nightWindow: {from:string, to:string},
 * }} timing
 * @returns {{ bucket: 'peak'|'offpeak'|'night', speedKmh: number }}
 */
export function pickSpeedBucket(originMinOfDay, timing) {
  // Normalize to [0, 1440) so 25:30 (next-day) collapses to 01:30.
  const t = ((originMinOfDay % (24 * 60)) + 24 * 60) % (24 * 60);

  const inWrappingWindow = (from, to) => {
    const f = hhmmToMin(from);
    const tt = hhmmToMin(to);
    if (f <= tt) return t >= f && t < tt;       // same-day window
    return t >= f || t < tt;                    // wraps midnight
  };

  if (timing.nightWindow && inWrappingWindow(timing.nightWindow.from, timing.nightWindow.to)) {
    return { bucket: 'night', speedKmh: timing.speedKmh.night };
  }
  if (Array.isArray(timing.peakWindows)) {
    for (const w of timing.peakWindows) {
      if (inWrappingWindow(w.from, w.to)) {
        return { bucket: 'peak', speedKmh: timing.speedKmh.peak };
      }
    }
  }
  return { bucket: 'offpeak', speedKmh: timing.speedKmh.offpeak };
}

/**
 * Compute arrival/departure times + shape_dist_traveled for every
 * stop on one trip.
 *
 * The origin stop has `arrival_time === departure_time === startSec`
 * (the bus is leaving on schedule). Every intermediate stop gets a
 * `dwellSec` window so departure - arrival = dwellSec. The terminus
 * has `arrival_time === departure_time` again (no further departure).
 *
 * @param {object} input
 * @param {number} input.startSec  origin departure, seconds since midnight
 * @param {Array<{stopId:string, lat:number, lon:number}>} input.stops  ordered by stop_sequence
 * @param {Array<{lat:number,lon:number}>} [input.shape]  may be empty / undefined
 * @param {{
 *   speedKmh: {peak:number, offpeak:number, night:number},
 *   peakWindows: Array<{from:string, to:string}>,
 *   nightWindow: {from:string, to:string},
 *   intermediateDwellSec: number,
 * }} input.timing
 * @returns {{
 *   arrivals: number[],
 *   departures: number[],
 *   shapeDistTraveledM: number[],
 *   speedBucket: 'peak'|'offpeak'|'night',
 *   speedKmh: number,
 * }}
 */
export function computeStopTimes({ startSec, stops, shape, timing }) {
  const n = stops.length;
  if (n === 0) {
    return { arrivals: [], departures: [], shapeDistTraveledM: [], speedBucket: 'offpeak', speedKmh: timing.speedKmh.offpeak };
  }
  if (n === 1) {
    return {
      arrivals: [startSec],
      departures: [startSec],
      shapeDistTraveledM: [0],
      speedBucket: 'offpeak',
      speedKmh: timing.speedKmh.offpeak,
    };
  }

  const cum = cumulativeShapeDistances(stops, shape ?? []);
  // Anchor on stop 0 — distances used for time interpolation are
  // "how far past origin", not "how far past shape start".
  const distFromOrigin = cum.map((d) => d - cum[0]);
  const totalDistM = distFromOrigin[n - 1];

  const originMin = Math.floor(startSec / 60);
  const { bucket, speedKmh } = pickSpeedBucket(originMin, timing);
  const speedMs = (speedKmh * 1000) / 3600;

  // Drive seconds from origin to each stop's projection on the shape.
  // Dwell at every intermediate stop pushes the next stop's arrival
  // back by dwellSec, so the schedule reads as "drive + dwell + drive
  // + dwell + …" the way operators publish it.
  const arrivals = new Array(n);
  const departures = new Array(n);
  arrivals[0] = startSec;
  departures[0] = startSec;
  let cumulativeDwellSec = 0;
  for (let i = 1; i < n; i++) {
    const driveSec = totalDistM > 0 ? Math.round(distFromOrigin[i] / speedMs) : 0;
    arrivals[i] = startSec + driveSec + cumulativeDwellSec;
    if (i < n - 1) {
      departures[i] = arrivals[i] + timing.intermediateDwellSec;
      cumulativeDwellSec += timing.intermediateDwellSec;
    } else {
      departures[i] = arrivals[i];
    }
  }

  return {
    arrivals,
    departures,
    // Round shape_dist_traveled to whole meters; GTFS doesn't mandate
    // a unit but consumers commonly assume meters when the column is
    // integer-valued.
    shapeDistTraveledM: cum.map((d) => Math.round(d)),
    speedBucket: bucket,
    speedKmh,
  };
}
