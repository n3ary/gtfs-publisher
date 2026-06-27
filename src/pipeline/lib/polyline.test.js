import { describe, it, expect } from 'vitest';
import {
  haversineMeters,
  projectOnPolyline,
  cumulativeShapeDistances,
} from './polyline.js';

/** Roughly Cluj-Napoca latitude; 0.01° lon ≈ 760 m. */
const LAT = 46.77;

const STRAIGHT_EAST = [
  { lat: LAT, lon: 23.60 },
  { lat: LAT, lon: 23.61 },
  { lat: LAT, lon: 23.62 },
  { lat: LAT, lon: 23.63 },
];

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(LAT, 23.60, LAT, 23.60)).toBe(0);
  });
  it('matches the equirectangular estimate for ~1 km', () => {
    const m = haversineMeters(LAT, 23.60, LAT, 23.61);
    expect(m).toBeGreaterThan(700);
    expect(m).toBeLessThan(800);
  });
});

describe('projectOnPolyline', () => {
  it('projects a point on the polyline at the right cumulative distance', () => {
    // Point at the midpoint between vertex 1 and vertex 2 (lon 23.615).
    const { distAlongM, perpDistM } = projectOnPolyline(
      { lat: LAT, lon: 23.615 },
      STRAIGHT_EAST,
    );
    expect(perpDistM).toBeLessThan(1);
    // Vertex 1 is at ~760 m, vertex 2 at ~1520 m → midpoint ~1140 m.
    expect(distAlongM).toBeGreaterThan(1100);
    expect(distAlongM).toBeLessThan(1180);
  });

  it('flags points far from the polyline via perpDistM', () => {
    const { perpDistM } = projectOnPolyline(
      { lat: LAT + 0.005, lon: 23.615 },  // ~555 m north of the line
      STRAIGHT_EAST,
    );
    expect(perpDistM).toBeGreaterThan(400);
  });

  it('throws on a single-point polyline', () => {
    expect(() => projectOnPolyline({ lat: LAT, lon: 23.61 }, [{ lat: LAT, lon: 23.60 }]))
      .toThrow(/at least 2 points/);
  });
});

describe('cumulativeShapeDistances', () => {
  it('returns monotonically non-decreasing distances along the shape', () => {
    const stops = [
      { lat: LAT, lon: 23.605 },
      { lat: LAT, lon: 23.615 },
      { lat: LAT, lon: 23.625 },
    ];
    const cum = cumulativeShapeDistances(stops, STRAIGHT_EAST);
    expect(cum).toHaveLength(3);
    // GTFS shape_dist_traveled is measured from the shape's start
    // vertex, so cum[0] is the first stop's projection — not 0.
    expect(cum[0]).toBeGreaterThan(0);
    expect(cum[1]).toBeGreaterThan(cum[0]);
    expect(cum[2]).toBeGreaterThan(cum[1]);
  });

  it('falls back to haversine when the polyline is missing (starts at 0)', () => {
    const stops = [
      { lat: LAT, lon: 23.60 },
      { lat: LAT, lon: 23.61 },
    ];
    const cum = cumulativeShapeDistances(stops, []);
    expect(cum[0]).toBe(0);
    expect(cum[1]).toBeGreaterThan(700);
    expect(cum[1]).toBeLessThan(800);
  });

  it('falls back to haversine for a stop that projects far off the shape', () => {
    const stops = [
      { lat: LAT, lon: 23.605 },         // close to the line
      { lat: LAT + 0.02, lon: 23.615 },  // ~2.2 km north, off-shape
      { lat: LAT, lon: 23.625 },         // back on the line
    ];
    const cum = cumulativeShapeDistances(stops, STRAIGHT_EAST, 200);
    // First + last stops project; the middle one uses haversine.
    expect(cum[1]).toBeGreaterThan(cum[0]);
    expect(cum[2]).toBeGreaterThan(cum[1]);
  });

  it('handles an empty input list', () => {
    expect(cumulativeShapeDistances([], STRAIGHT_EAST)).toEqual([]);
  });

  it('enforces strict monotonicity even when two stops project to the same spot', () => {
    // Two stops projecting to nearly the same shape point.
    const stops = [
      { lat: LAT, lon: 23.615 },
      { lat: LAT + 0.00001, lon: 23.615 },  // ~1 m to the north
    ];
    const cum = cumulativeShapeDistances(stops, STRAIGHT_EAST);
    expect(cum[1]).toBeGreaterThan(cum[0]);
  });
});
