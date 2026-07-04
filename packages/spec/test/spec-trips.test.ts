import { describe, it, expect } from 'vitest';
import { parseTrips } from '../src/spec/trips.js';

const CSV = [
  'trip_id,route_id,service_id,direction_id',
  'T1,R1,S1,0',
  'T2,R1,S1,1',
  'T3,R2,S2,',
].join('\n');

describe('parseTrips', () => {
  it('parses all trips including empty optional fields', async () => {
    const rows = await parseTrips(CSV);
    expect(rows).toHaveLength(3);
    // csv-parse returns '' for empty optional cells — that's what callers
    // should expect. `.undefined` only happens if the column is missing
    // from the header entirely (separate test).
    expect(rows[2]?.direction_id).toBe('');
  });

  it('rejects missing required service_id', async () => {
    const csv = 'trip_id,route_id,direction_id\nT1,R1,0';
    await expect(parseTrips(csv)).rejects.toThrow();
  });
});