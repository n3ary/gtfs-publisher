import { describe, expect, it } from 'vitest';
import {
  type LatLon,
  haversineMeters,
  projectOnPolyline,
  distAlongBetween,
  measurePolyline,
  pointAtDistance,
  bearingBetween,
  bearingAtDistance,
  lerpLatLon,
  findSegmentAtDistance,
  type Polyline,
  type MeasuredPolyline,
} from '../src/shape/index.js';

// A straight east-west polyline near Cluj (~46.77°N). At this
// latitude, 1° of longitude ≈ 76 km. Vertices roughly 1 km apart so
// math is easy to eyeball.
const STRAIGHT: Polyline = [
  { lat: 46.770, lon: 23.580 }, // 0
  { lat: 46.770, lon: 23.5931 }, // ~1 km east
  { lat: 46.770, lon: 23.6062 }, // ~2 km east
  { lat: 46.770, lon: 23.6193 }, // ~3 km east
];

// An L-shaped polyline: 1 km east, then 1 km north.
const ELBOW: Polyline = [
  { lat: 46.770, lon: 23.580 },
  { lat: 46.770, lon: 23.5931 }, // corner
  { lat: 46.779, lon: 23.5931 }, // ~1 km north (~0.009° lat = 1 km)
];

describe('haversineMeters', () => {
  it('returns 0 for the same point', () => {
    expect(haversineMeters(46.77, 23.59, 46.77, 23.59)).toBeCloseTo(0, 5);
  });

  it('returns ~111 km for 1 degree of latitude', () => {
    // 1° latitude ≈ 111,195 m at the equator
    const m = haversineMeters(0, 0, 1, 0);
    expect(m).toBeGreaterThan(110000);
    expect(m).toBeLessThan(112000);
  });

  it('symmetric (a→b equals b→a)', () => {
    const ab = haversineMeters(46.77, 23.59, 46.80, 23.62);
    const ba = haversineMeters(46.80, 23.62, 46.77, 23.59);
    expect(ab).toBeCloseTo(ba, 5);
  });
});

describe('projectOnPolyline', () => {
  it('returns the start vertex for a point exactly at the origin', () => {
    const out = projectOnPolyline(STRAIGHT[0], STRAIGHT);
    expect(out.distAlongM).toBeCloseTo(0, 0);
    expect(out.perpDistM).toBeCloseTo(0, 0);
    expect(out.segmentIdx).toBe(0);
  });

  it('projects a point dead-center on the second segment', () => {
    // Midpoint of segment 1: between 23.5931 and 23.6062
    const mid = { lat: 46.770, lon: 23.5996 };
    const out = projectOnPolyline(mid, STRAIGHT);
    expect(out.segmentIdx).toBe(1);
    // 1 km (segment 0) + 0.5 km (half of segment 1) ≈ 1500 m
    expect(out.distAlongM).toBeGreaterThan(1400);
    expect(out.distAlongM).toBeLessThan(1600);
    expect(out.perpDistM).toBeLessThan(50);
  });

  it('projects an off-route point perpendicular to its nearest segment', () => {
    // 1 km east of origin, but 100 m north of the polyline.
    const off = { lat: 46.7709, lon: 23.5931 };
    const out = projectOnPolyline(off, STRAIGHT);
    expect(out.perpDistM).toBeGreaterThan(50);
    expect(out.perpDistM).toBeLessThan(150);
    // Along-distance should still be ~1 km (the projection lands at the corner).
    expect(out.distAlongM).toBeGreaterThan(900);
    expect(out.distAlongM).toBeLessThan(1100);
  });

  it('clamps to segment endpoints (does not extrapolate past the polyline)', () => {
    // Way east of the polyline end.
    const past = { lat: 46.770, lon: 23.7 };
    const out = projectOnPolyline(past, STRAIGHT);
    // distAlongM should equal the polyline's total length (~3 km), not more.
    expect(out.distAlongM).toBeGreaterThan(2800);
    expect(out.distAlongM).toBeLessThan(3200);
  });

  it('clamps to start when point is way west', () => {
    const before = { lat: 46.770, lon: 23.5 };
    const out = projectOnPolyline(before, STRAIGHT);
    expect(out.distAlongM).toBeCloseTo(0, 0);
  });

  it('handles an L-shaped polyline (multi-segment with direction change)', () => {
    // A point right at the elbow corner.
    const out = projectOnPolyline(ELBOW[1], ELBOW);
    expect(out.distAlongM).toBeGreaterThan(900);
    expect(out.distAlongM).toBeLessThan(1100);
    expect(out.perpDistM).toBeLessThan(10);
  });

  it('throws on a polyline with fewer than 2 points', () => {
    expect(() => projectOnPolyline({ lat: 0, lon: 0 }, [])).toThrow();
    expect(() => projectOnPolyline({ lat: 0, lon: 0 }, [{ lat: 0, lon: 0 }])).toThrow();
  });
});

describe('distAlongBetween', () => {
  it('is positive when "to" is further along than "from"', () => {
    const from = projectOnPolyline({ lat: 46.770, lon: 23.585 }, STRAIGHT);
    const to = projectOnPolyline({ lat: 46.770, lon: 23.6 }, STRAIGHT);
    expect(distAlongBetween(from, to)).toBeGreaterThan(0);
  });

  it('is negative when "to" is before "from" (vehicle already passed)', () => {
    const from = projectOnPolyline({ lat: 46.770, lon: 23.61 }, STRAIGHT);
    const to = projectOnPolyline({ lat: 46.770, lon: 23.59 }, STRAIGHT);
    expect(distAlongBetween(from, to)).toBeLessThan(0);
  });
});

describe('measurePolyline + pointAtDistance', () => {
  it('cumulative distance matches the per-segment haversine sum', () => {
    const measured = measurePolyline(STRAIGHT);
    const expected = STRAIGHT.length - 1 === 3
      ? 3 * haversineMeters(STRAIGHT[0].lat, STRAIGHT[0].lon, STRAIGHT[1].lat, STRAIGHT[1].lon)
      : 0;
    expect(measured.totalDistM).toBeCloseTo(expected, 0);
  });

  it('pointAtDistance(0) returns the first vertex', () => {
    const measured = measurePolyline(STRAIGHT);
    const p = pointAtDistance(measured, 0);
    expect(p.lat).toBeCloseTo(STRAIGHT[0].lat, 5);
    expect(p.lon).toBeCloseTo(STRAIGHT[0].lon, 5);
  });

  it('pointAtDistance(total) returns the last vertex', () => {
    const measured = measurePolyline(STRAIGHT);
    const p = pointAtDistance(measured, measured.totalDistM);
    const last = STRAIGHT[STRAIGHT.length - 1];
    expect(p.lat).toBeCloseTo(last.lat, 5);
    expect(p.lon).toBeCloseTo(last.lon, 5);
  });

  it('pointAtDistance clamps to the start when distM < 0', () => {
    const measured = measurePolyline(STRAIGHT);
    const p = pointAtDistance(measured, -10);
    expect(p.lat).toBeCloseTo(STRAIGHT[0].lat, 5);
  });

  it('pointAtDistance clamps to the end when distM > total', () => {
    const measured = measurePolyline(STRAIGHT);
    const p = pointAtDistance(measured, measured.totalDistM + 1e6);
    const last = STRAIGHT[STRAIGHT.length - 1];
    expect(p.lat).toBeCloseTo(last.lat, 5);
  });

  it('pointAtDistance on a single-point polyline returns that point regardless of distM', () => {
    const single = measurePolyline([STRAIGHT[0]]);
    expect(pointAtDistance(single, -10)).toEqual(STRAIGHT[0]);
    expect(pointAtDistance(single, 0)).toEqual(STRAIGHT[0]);
    expect(pointAtDistance(single, 999999)).toEqual(STRAIGHT[0]);
  });

  it('pointAtDistance throws on an empty polyline', () => {
    const empty = measurePolyline([]);
    expect(() => pointAtDistance(empty, 0)).toThrow();
  });

  it('pointAtDistance at half a segment gives a midpoint', () => {
    const measured = measurePolyline(STRAIGHT);
    const halfSeg = measured.cumDistM[1] / 2;
    const p = pointAtDistance(measured, halfSeg);
    const a = STRAIGHT[0];
    const b = STRAIGHT[1];
    expect(p.lat).toBeCloseTo((a.lat + b.lat) / 2, 5);
    expect(p.lon).toBeCloseTo((a.lon + b.lon) / 2, 5);
  });
});

describe('bearingBetween', () => {
  it('returns 0 for due-north (a below b)', () => {
    const b = bearingBetween({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(b).toBeCloseTo(0, 0);
  });

  it('returns 90 for due-east', () => {
    const b = bearingBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(b).toBeCloseTo(90, 0);
  });

  it('returns 180 for due-south', () => {
    const b = bearingBetween({ lat: 1, lon: 0 }, { lat: 0, lon: 0 });
    expect(b).toBeCloseTo(180, 0);
  });

  it('returns 270 for due-west', () => {
    const b = bearingBetween({ lat: 0, lon: 1 }, { lat: 0, lon: 0 });
    expect(b).toBeCloseTo(270, 0);
  });
});

describe('bearingAtDistance', () => {
  it('returns 90 (east) at the first segment of the east-west polyline', () => {
    const measured = measurePolyline(STRAIGHT);
    const b = bearingAtDistance(measured, measured.cumDistM[0]);
    expect(b).toBeCloseTo(90, 0);
  });

  it('returns 0 for a polyline with < 2 points', () => {
    const empty: MeasuredPolyline = { points: [], cumDistM: [], totalDistM: 0 };
    expect(bearingAtDistance(empty, 0)).toBe(0);
  });
});

describe('lerpLatLon', () => {
  it('returns a when t=0', () => {
    const a: LatLon = { lat: 1, lon: 2 };
    const b: LatLon = { lat: 5, lon: 6 };
    expect(lerpLatLon(a, b, 0)).toEqual(a);
  });
  it('returns b when t=1', () => {
    const a: LatLon = { lat: 1, lon: 2 };
    const b: LatLon = { lat: 5, lon: 6 };
    expect(lerpLatLon(a, b, 1)).toEqual(b);
  });
  it('returns the midpoint when t=0.5', () => {
    const a: LatLon = { lat: 0, lon: 0 };
    const b: LatLon = { lat: 10, lon: 20 };
    expect(lerpLatLon(a, b, 0.5)).toEqual({ lat: 5, lon: 10 });
  });
  it('extrapolates when t > 1', () => {
    const a: LatLon = { lat: 0, lon: 0 };
    const b: LatLon = { lat: 10, lon: 20 };
    expect(lerpLatLon(a, b, 2)).toEqual({ lat: 20, lon: 40 });
  });
});

describe('findSegmentAtDistance', () => {
  it('finds the segment containing a distance', () => {
    // cumDistM = [0, 100, 250, 400] means segments: [0,100], [100,250], [250,400].
    // The function's invariant is cumDistM[lo] <= distM < cumDistM[lo+1]
    // (so boundary values land in the higher segment).
    expect(findSegmentAtDistance([0, 100, 250, 400], 50)).toBe(0);
    expect(findSegmentAtDistance([0, 100, 250, 400], 100)).toBe(1);  // boundary
    expect(findSegmentAtDistance([0, 100, 250, 400], 200)).toBe(1);
    expect(findSegmentAtDistance([0, 100, 250, 400], 250)).toBe(2);  // boundary
    expect(findSegmentAtDistance([0, 100, 250, 400], 399)).toBe(2);
  });
});