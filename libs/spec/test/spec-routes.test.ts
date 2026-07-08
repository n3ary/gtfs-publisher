import { describe, it, expect } from 'vitest';
import { parseRoutes, parseRoutesStream } from '../src/spec/routes.js';

const CSV = [
  'route_id,agency_id,route_short_name,route_long_name,route_type',
  'R1,CTP,1,Main Street,3',
  'R2,CTP,2,Park Avenue,3',
].join('\n');

describe('parseRoutes', () => {
  it('parses all routes', async () => {
    const rows = await parseRoutes(CSV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ route_id: 'R1', route_type: '3' });
  });
});

describe('parseRoutesStream', () => {
  it('streams rows', async () => {
    async function* chunks() {
      yield CSV;
    }
    const out: unknown[] = [];
    for await (const row of parseRoutesStream(chunks())) {
      out.push(row);
    }
    expect(out).toHaveLength(2);
  });
});