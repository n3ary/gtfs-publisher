import { describe, it, expect } from 'vitest';
import { AgencySchema } from '../src/schema/agency.js';

describe('AgencySchema', () => {
  it('parses a minimal valid agency (agency_name only)', () => {
    const result = AgencySchema.parse({ agency_name: 'CTP Cluj-Napoca' });
    expect(result.agency_name).toBe('CTP Cluj-Napoca');
    expect(result.agency_id).toBeNull();
    expect(result.agency_url).toBeNull();
  });

  it('parses a fully populated agency', () => {
    const result = AgencySchema.parse({
      agency_name: 'BVG',
      agency_id: 'bvg',
      agency_url: 'https://www.bvg.de',
    });
    expect(result.agency_id).toBe('bvg');
    expect(result.agency_url).toBe('https://www.bvg.de');
  });

  it('rejects an empty agency_name', () => {
    expect(() => AgencySchema.parse({ agency_name: '' })).toThrow();
  });

  it('rejects a missing agency_name', () => {
    expect(() => AgencySchema.parse({})).toThrow();
  });

  it('rejects a non-URL agency_url', () => {
    expect(() => AgencySchema.parse({
      agency_name: 'BVG',
      agency_url: 'not-a-url',
    })).toThrow();
  });

  it('rejects unknown keys (strict mode)', () => {
    expect(() => AgencySchema.parse({
      agency_name: 'BVG',
      agency_phone: '+49 30 19449',
    })).toThrow();
  });
});