import { describe, it, expect } from 'vitest';
import { parseStops, parseStopsStream, StopRowSchema } from '../src/spec/stops.js';

const CSV = [
  'stop_id,stop_name,stop_lat,stop_lon',
  'A,Central,46.77,23.59',
  'B,North,46.80,23.60',
  'C,South,46.74,23.55',
].join('\n');

describe('parseStops', () => {
  it('parses all stops', async () => {
    const rows = await parseStops(CSV);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ stop_id: 'A', stop_lat: '46.77' });
  });

  it('rejects a row with empty stop_id', async () => {
    const csv = 'stop_id,stop_name,stop_lat,stop_lon\n,Central,46.77,23.59';
    await expect(parseStops(csv)).rejects.toThrow();
  });
});

describe('parseStopsStream', () => {
  it('streams rows from an async iterable', async () => {
    async function* chunks() {
      yield CSV;
    }
    const out: unknown[] = [];
    for await (const row of parseStopsStream(chunks())) {
      out.push(row);
    }
    expect(out).toHaveLength(3);
  });
});

describe('StopRowSchema', () => {
  it('passes through unknown columns (passthrough)', () => {
    const row = StopRowSchema.parse({
      stop_id: 'A',
      vendor_specific_field: 'ignored',
    });
    expect(row.stop_id).toBe('A');
    expect((row as Record<string, unknown>).vendor_specific_field).toBe('ignored');
  });
});