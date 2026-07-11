import { describe, it, expect } from 'vitest';
import { RealtimeSchema } from '../src/schema/realtime.js';

describe('RealtimeSchema', () => {
  it('accepts an empty object (no realtime)', () => {
    expect(RealtimeSchema.parse({})).toEqual({});
  });

  it('accepts a full realtime bundle', () => {
    const result = RealtimeSchema.parse({
      vehicle_positions: 'https://example.com/vp.pb',
      trip_updates: 'https://example.com/tu.pb',
      service_alerts: 'https://example.com/sa.pb',
    });
    expect(result.vehicle_positions).toBe('https://example.com/vp.pb');
  });

  it('rejects http:// (must be https)', () => {
    expect(() => RealtimeSchema.parse({
      vehicle_positions: 'http://example.com/vp.pb',
    })).toThrow();
  });

  it('rejects non-URL values', () => {
    expect(() => RealtimeSchema.parse({
      vehicle_positions: 'not-a-url',
    })).toThrow();
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() => RealtimeSchema.parse({
      vehicle_positions: 'https://example.com/vp.pb',
      fuel_prices: 'https://example.com/fuel.pb',
    })).toThrow();
  });

  it('accepts extra_vehicle_positions: [] (empty array)', () => {
    expect(RealtimeSchema.parse({
      vehicle_positions: 'https://example.com/vp.pb',
      extra_vehicle_positions: [],
    })).toEqual({
      vehicle_positions: 'https://example.com/vp.pb',
      extra_vehicle_positions: [],
    });
  });

  it('accepts multiple extras, all https', () => {
    const result = RealtimeSchema.parse({
      vehicle_positions: 'https://example.com/primary.pb',
      extra_vehicle_positions: [
        'https://mirror1.example.com/vp.pb',
        'https://mirror2.example.com/vp.pb',
      ],
    });
    expect(result.extra_vehicle_positions).toHaveLength(2);
  });

  it('rejects non-https extras', () => {
    expect(() => RealtimeSchema.parse({
      vehicle_positions: 'https://example.com/primary.pb',
      extra_vehicle_positions: ['http://mirror1.example.com/vp.pb'],
    })).toThrow();
  });

  it('accepts upstream_vehicle_positions (https)', () => {
    const result = RealtimeSchema.parse({
      vehicle_positions: 'https://consumer.example.com/vp.pb',
      upstream_vehicle_positions: 'https://upstream.example.com/vp.pb',
    });
    expect(result.upstream_vehicle_positions).toBe('https://upstream.example.com/vp.pb');
  });

  it('accepts upstream_vehicle_positions without vehicle_positions', () => {
    const result = RealtimeSchema.parse({
      upstream_vehicle_positions: 'https://upstream.example.com/vp.pb',
    });
    expect(result.upstream_vehicle_positions).toBe('https://upstream.example.com/vp.pb');
    expect(result.vehicle_positions).toBeUndefined();
  });

  it('rejects http:// upstream_vehicle_positions', () => {
    expect(() => RealtimeSchema.parse({
      upstream_vehicle_positions: 'http://upstream.example.com/vp.pb',
    })).toThrow();
  });
});