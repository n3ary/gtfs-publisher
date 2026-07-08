/**
 * Tests for the networks.txt + route_networks.txt convenience writers.
 *
 * Property under test:
 *   networksToTxt(rows) emits the canonical header + RFC 4180-quoted
 *   rows; same for routeNetworksToTxt. Empty input → empty string.
 *
 * Why a separate file: `serialize.test.ts` exercises the generic
 * serializeRows(schema, rows) path. These helpers are a thin
 * csv-stringify wrapper for the two tables every adapter emits but
 * the spec doesn't model with a schema — keeps the public surface
 * small while still being spec-owned.
 */
import { describe, it, expect } from 'vitest';
import { networksToTxt, routeNetworksToTxt } from '../src/serialize/index.js';

describe('networksToTxt', () => {
  it('emits header + rows for a single-row input', () => {
    const csv = networksToTxt([['school', 'Transport Elevi']]);
    expect(csv).toBe('network_id,network_name\nschool,Transport Elevi\n');
  });

  it('emits multiple rows in order', () => {
    const csv = networksToTxt([
      ['school', 'Transport Elevi'],
      ['festival', 'Untold'],
      ['metroline', 'Metropolitan'],
    ]);
    expect(csv).toBe(
      'network_id,network_name\n' +
      'school,Transport Elevi\n' +
      'festival,Untold\n' +
      'metroline,Metropolitan\n',
    );
  });

  it('returns empty string for empty input (caller drops the file from zip)', () => {
    expect(networksToTxt([])).toBe('');
  });

  it('quotes fields with commas (RFC 4180)', () => {
    const csv = networksToTxt([['cat1', 'With, comma']]);
    expect(csv).toContain('"With, comma"');
  });
});

describe('routeNetworksToTxt', () => {
  it('emits header + rows', () => {
    const csv = routeNetworksToTxt([
      ['school', '93'],
      ['school', '145'],
      ['metroline', 'M26'],
    ]);
    expect(csv).toBe(
      'network_id,route_id\n' +
      'school,93\n' +
      'school,145\n' +
      'metroline,M26\n',
    );
  });

  it('returns empty string for empty input', () => {
    expect(routeNetworksToTxt([])).toBe('');
  });

  it('quotes fields with double-quotes (RFC 4180)', () => {
    const csv = routeNetworksToTxt([['cat"1', 'R1']]);
    expect(csv).toContain('"cat""1"');
  });
});