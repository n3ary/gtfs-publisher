import { describe, it, expect } from 'vitest';
import { pickSpeedBucket, computeStopTimes } from './timing.js';

const TIMING = {
  speedKmh: { peak: 14, offpeak: 22, night: 28 },
  peakWindows: [
    { from: '07:00', to: '09:30' },
    { from: '16:00', to: '19:00' },
  ],
  nightWindow: { from: '22:30', to: '05:30' },
  intermediateDwellSec: 20,
};

describe('pickSpeedBucket', () => {
  it('picks night for midnight wrap', () => {
    expect(pickSpeedBucket(0,   TIMING).bucket).toBe('night');
    expect(pickSpeedBucket(330, TIMING).bucket).toBe('offpeak');   // 05:30
    expect(pickSpeedBucket(329, TIMING).bucket).toBe('night');     // 05:29
    expect(pickSpeedBucket(23 * 60, TIMING).bucket).toBe('night'); // 23:00
  });
  it('picks peak for morning + evening rush', () => {
    expect(pickSpeedBucket(7 * 60 + 30, TIMING).bucket).toBe('peak');   // 07:30
    expect(pickSpeedBucket(17 * 60, TIMING).bucket).toBe('peak');       // 17:00
  });
  it('picks offpeak for midday + late afternoon', () => {
    expect(pickSpeedBucket(12 * 60, TIMING).bucket).toBe('offpeak');    // 12:00
    expect(pickSpeedBucket(10 * 60, TIMING).bucket).toBe('offpeak');    // 10:00
    expect(pickSpeedBucket(20 * 60, TIMING).bucket).toBe('offpeak');    // 20:00
  });
  it('normalizes post-midnight minutes (≥ 1440)', () => {
    // 25:30 = 01:30 of the next day → night.
    expect(pickSpeedBucket(25 * 60 + 30, TIMING).bucket).toBe('night');
  });
});

/** Straight-east shape at Cluj latitude. 0.01° lon ≈ 760 m. */
const SHAPE = [
  { lat: 46.77, lon: 23.60 },
  { lat: 46.77, lon: 23.61 },
  { lat: 46.77, lon: 23.62 },
  { lat: 46.77, lon: 23.63 },
];

const STOPS = [
  { stopId: 'A', lat: 46.77, lon: 23.605 },   // ~380 m along shape
  { stopId: 'B', lat: 46.77, lon: 23.615 },   // ~1140 m
  { stopId: 'C', lat: 46.77, lon: 23.625 },   // ~1900 m
];

describe('computeStopTimes', () => {
  it('matches the requested origin departure exactly', () => {
    const out = computeStopTimes({
      startSec: 8 * 3600 + 30 * 60,           // 08:30 — peak
      stops: STOPS,
      shape: SHAPE,
      timing: TIMING,
    });
    expect(out.arrivals[0]).toBe(8 * 3600 + 30 * 60);
    expect(out.departures[0]).toBe(out.arrivals[0]);
    expect(out.speedBucket).toBe('peak');
  });

  it('inserts dwell at intermediate stops only', () => {
    const out = computeStopTimes({
      startSec: 12 * 3600,                     // 12:00 — offpeak
      stops: STOPS,
      shape: SHAPE,
      timing: TIMING,
    });
    // Origin: arrival == departure (no dwell — just leaving).
    expect(out.departures[0] - out.arrivals[0]).toBe(0);
    // Intermediate: 20 s gap.
    expect(out.departures[1] - out.arrivals[1]).toBe(20);
    // Terminus: arrival == departure (no dwell — end of trip).
    expect(out.departures[2] - out.arrivals[2]).toBe(0);
  });

  it('uses faster speed at night than at peak (shorter total trip)', () => {
    const peak = computeStopTimes({
      startSec: 8 * 3600,           // 08:00 — peak (14 km/h)
      stops: STOPS,
      shape: SHAPE,
      timing: TIMING,
    });
    const night = computeStopTimes({
      startSec: 1 * 3600,           // 01:00 — night (28 km/h)
      stops: STOPS,
      shape: SHAPE,
      timing: TIMING,
    });
    const peakDuration = peak.arrivals[2] - peak.arrivals[0];
    const nightDuration = night.arrivals[2] - night.arrivals[0];
    expect(nightDuration).toBeLessThan(peakDuration);
    // Peak is roughly 2× as slow → roughly 2× the drive time + same dwell.
    expect(peakDuration).toBeGreaterThan(nightDuration * 1.5);
  });

  it('produces monotonically increasing arrivals + shape_dist_traveled', () => {
    const out = computeStopTimes({
      startSec: 12 * 3600,
      stops: STOPS,
      shape: SHAPE,
      timing: TIMING,
    });
    for (let i = 1; i < out.arrivals.length; i++) {
      expect(out.arrivals[i]).toBeGreaterThanOrEqual(out.arrivals[i - 1]);
      expect(out.shapeDistTraveledM[i]).toBeGreaterThan(out.shapeDistTraveledM[i - 1]);
    }
  });

  it('falls back gracefully when no shape is provided', () => {
    const out = computeStopTimes({
      startSec: 12 * 3600,
      stops: STOPS,
      shape: [],
      timing: TIMING,
    });
    expect(out.arrivals).toHaveLength(3);
    expect(out.shapeDistTraveledM[0]).toBe(0);
    expect(out.shapeDistTraveledM[2]).toBeGreaterThan(0);
  });

  it('handles a single-stop trip', () => {
    const out = computeStopTimes({
      startSec: 8 * 3600,
      stops: [STOPS[0]],
      shape: SHAPE,
      timing: TIMING,
    });
    expect(out.arrivals).toEqual([8 * 3600]);
    expect(out.departures).toEqual([8 * 3600]);
    expect(out.shapeDistTraveledM).toEqual([0]);
  });
});
