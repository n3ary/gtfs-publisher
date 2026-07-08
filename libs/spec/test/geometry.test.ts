import { describe, it, expect } from 'vitest';
import { BboxSchema, CenterSchema, ValiditySchema } from '../src/schema/geometry.js';

describe('BboxSchema', () => {
  it('accepts a valid bbox', () => {
    const result = BboxSchema.parse({
      minLat: 45.0, minLon: 22.0,
      maxLat: 47.5, maxLon: 25.5,
    });
    expect(result.minLat).toBe(45.0);
  });

  it('rejects out-of-range latitude', () => {
    expect(() => BboxSchema.parse({
      minLat: -91, minLon: 0, maxLat: 0, maxLon: 0,
    })).toThrow();
    expect(() => BboxSchema.parse({
      minLat: 0, minLon: 0, maxLat: 91, maxLon: 0,
    })).toThrow();
  });

  it('rejects out-of-range longitude', () => {
    expect(() => BboxSchema.parse({
      minLat: 0, minLon: -181, maxLat: 0, maxLon: 0,
    })).toThrow();
  });
});

describe('CenterSchema', () => {
  it('accepts a valid center', () => {
    expect(CenterSchema.parse({ lat: 46.77, lon: 23.59 })).toEqual({
      lat: 46.77, lon: 23.59,
    });
  });

  it('rejects out-of-range values', () => {
    expect(() => CenterSchema.parse({ lat: 100, lon: 0 })).toThrow();
    expect(() => CenterSchema.parse({ lat: 0, lon: -200 })).toThrow();
  });
});

describe('ValiditySchema', () => {
  it('accepts a YYYY-MM-DD date', () => {
    expect(ValiditySchema.parse({ from: '2026-07-01', until: '2026-12-31' })).toEqual({
      from: '2026-07-01', until: '2026-12-31',
    });
  });

  it('accepts null for either bound', () => {
    expect(ValiditySchema.parse({ from: null, until: '2026-12-31' }).from).toBeNull();
    expect(ValiditySchema.parse({ from: '2026-07-01', until: null }).until).toBeNull();
  });

  it('rejects a malformed date', () => {
    expect(() => ValiditySchema.parse({ from: 'not-a-date', until: null })).toThrow();
    expect(() => ValiditySchema.parse({ from: '2026/07/01', until: null })).toThrow();
  });
});