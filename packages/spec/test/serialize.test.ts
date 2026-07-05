/**
 * Round-trip tests for the GTFS CSV serializer.
 *
 * Property under test:
 *   For any schema and any row that conforms to it,
 *   parseRows(schema, serializeRows(schema, [row])[0])
 *   MUST produce a row with identical field values.
 *
 * This is what protects adapters from the column-shift bug class
 * (PR #8 had to fix this in cluj-napoca's stopsToTxt: hand-positioned
 * values against hand-positioned headers drifted, leaving the
 * stop_lat column empty). With serializeRows, the schema drives
 * BOTH header and value positions — drift becomes structurally
 * impossible.
 */
import { describe, it, expect } from 'vitest';
import { serializeRows, serializeRow } from '../src/serialize/index.js';
import { parseStops } from '../src/spec/stops.js';
import { parseRoutes } from '../src/spec/routes.js';
import { parseCalendar } from '../src/spec/calendar.js';
import {
  StopRowSchema,
  RouteRowSchema,
  CalendarRowSchema,
} from '../src/spec/index.js';
import type { StopRow, RouteRow, CalendarRow } from '../src/spec/index.js';

describe('serializeRows', () => {
  it('emits the schema-defined header in spec order', async () => {
    const csv = await serializeRows(StopRowSchema, []);
    const headerLine = csv.split('\n')[0];
    // The phantom stop_lat_lon_present field was removed in 0.4.0.
    // If it ever sneaks back in, this assertion fails — which is
    // the point: spec changes must be intentional, not silent.
    expect(headerLine).not.toContain('stop_lat_lon_present');
    expect(headerLine).toBe(
      'stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,stop_url,' +
        'location_type,parent_station,stop_timezone,wheelchair_boarding,' +
        'level_id,platform_code',
    );
  });

  it('writes values at the schema-defined column positions (stops)', async () => {
    const row: StopRow = {
      stop_id: 'S1',
      stop_name: 'Central',
      stop_lat: '46.770000',
      stop_lon: '23.590000',
      location_type: '0',
    };
    const csv = await serializeRow(StopRowSchema, row);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    // Data line MUST have stop_lat at index 3 (zero-based) — the
    // exact bug PR #8 had to fix.
    const cells = lines[1]!.split(',');
    expect(cells[0]).toBe('S1');          // stop_id
    expect(cells[2]).toBe('Central');     // stop_name
    expect(cells[3]).toBe('46.770000');   // stop_lat
    expect(cells[4]).toBe('23.590000');   // stop_lon
    expect(cells[7]).toBe('0');           // location_type
  });

  it('round-trips stops through serialize → parse', async () => {
    const original: StopRow[] = [
      { stop_id: 'A', stop_name: 'Alpha', stop_lat: '46.77', stop_lon: '23.59' },
      { stop_id: 'B', stop_name: 'Beta',  stop_lat: '46.80', stop_lon: '23.60',
        location_type: '1', parent_station: 'P' },
      { stop_id: 'C', stop_name: 'Gamma', stop_lat: '46.74', stop_lon: '23.55',
        wheelchair_boarding: '1' },
    ];
    const csv = await serializeRows(StopRowSchema, original);
    const reparsed = await parseStops(csv);
    expect(reparsed).toHaveLength(original.length);
    // Use toMatchObject (not toEqual) because parseStops fills in
    // optional fields as empty strings, while our input leaves them
    // undefined. Round-trip is lossy on undefined ↔ '' but values
    // we explicitly set must round-trip exactly.
    for (let i = 0; i < original.length; i++) {
      expect(reparsed[i]).toMatchObject(original[i]!);
    }
  });

  it('round-trips routes through serialize → parse', async () => {
    const original: RouteRow[] = [
      { route_id: 'R1', agency_id: '2', route_short_name: '1',
        route_long_name: 'Downtown', route_type: '3', route_color: 'F3513C' },
    ];
    const csv = await serializeRows(RouteRowSchema, original);
    const reparsed = await parseRoutes(csv);
    expect(reparsed[0]).toMatchObject(original[0]!);
  });

  it('round-trips calendar through serialize → parse', async () => {
    const original: CalendarRow[] = [
      { service_id: 'WKD', monday: '1', tuesday: '1', wednesday: '1',
        thursday: '1', friday: '1', saturday: '0', sunday: '0',
        start_date: '20260701', end_date: '20261231' },
    ];
    const csv = await serializeRows(CalendarRowSchema, original);
    const reparsed = await parseCalendar(csv);
    expect(reparsed[0]).toMatchObject(original[0]!);
  });

  it('RFC 4180 quotes fields containing commas/quotes/newlines', async () => {
    const row: StopRow = {
      stop_id: 'S1',
      stop_name: 'Central, North', // comma forces quoting
    };
    const csv = await serializeRow(StopRowSchema, row);
    expect(csv).toContain('"Central, North"');
  });

  it('quotes fields containing double quotes (escaped as "")', async () => {
    const row: StopRow = {
      stop_id: 'S1',
      stop_name: 'O"Reilly',
    };
    const csv = await serializeRow(StopRowSchema, row);
    expect(csv).toContain('"O""Reilly"');
    // Round-trip too.
    const reparsed = await parseStops(csv);
    expect(reparsed[0]?.stop_name).toBe('O"Reilly');
  });

  it('emits a trailing newline (matches existing hand-rolled writers)', async () => {
    const csv = await serializeRows(StopRowSchema, []);
    expect(csv.endsWith('\n')).toBe(true);
  });

  it('writes empty cells for missing optional fields (no literal "undefined"/"null")', async () => {
    const row: StopRow = { stop_id: 'S1' }; // everything else undefined
    const csv = await serializeRow(StopRowSchema, row);
    const cells = csv.trim().split('\n')[1]!.split(',');
    // Cell for stop_name should be empty, not "undefined" or "null".
    expect(cells[2]).toBe('');
  });
});

describe('serializeRows error cases', () => {
  it('throws TypeError if schema is not z.object({...})', async () => {
    // Pass a non-object zod schema (a single-field type, no `.shape`
    // at the top level) — should error loudly.
    await expect(serializeRows(StopRowSchema.shape.stop_name, ['x'])).rejects.toThrow(/z\.object/);
  });
});