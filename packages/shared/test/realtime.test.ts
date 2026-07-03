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
});