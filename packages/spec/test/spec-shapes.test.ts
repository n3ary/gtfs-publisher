import { describe, it, expect } from 'vitest';
import { parseShapesStream } from '../src/spec/shapes.js';

const CSV = [
  'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
  'S1,46.77,23.59,1',
  'S1,46.78,23.60,2',
  'S1,46.79,23.61,3',
].join('\n');

describe('parseShapesStream', () => {
  it('streams shape points', async () => {
    async function* chunks() {
      yield CSV;
    }
    const out: unknown[] = [];
    for await (const row of parseShapesStream(chunks())) {
      out.push(row);
    }
    expect(out).toHaveLength(3);
  });
});