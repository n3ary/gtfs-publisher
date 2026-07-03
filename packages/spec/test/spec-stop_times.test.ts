import { describe, it, expect } from 'vitest';
import { parseStopTimesStream } from '../src/spec/stop_times.js';

const CSV = [
  'trip_id,arrival_time,departure_time,stop_id,stop_sequence',
  'T1,08:00:00,08:00:30,A,1',
  'T1,08:01:30,08:02:00,B,2',
  'T1,08:03:00,08:03:30,C,3',
].join('\n');

describe('parseStopTimesStream', () => {
  it('streams all stop_times', async () => {
    async function* chunks() {
      yield CSV;
    }
    const out: unknown[] = [];
    for await (const row of parseStopTimesStream(chunks())) {
      out.push(row);
    }
    expect(out).toHaveLength(3);
  });

  it('rejects a row with empty stop_sequence', async () => {
    const bad = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,08:00:00,08:00:00,A,';
    async function* chunks() {
      yield bad;
    }
    const iter = parseStopTimesStream(chunks());
    await expect(iter.next()).rejects.toThrow();
  });
});