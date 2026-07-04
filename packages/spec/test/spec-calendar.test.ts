import { describe, it, expect } from 'vitest';
import { parseCalendar } from '../src/spec/calendar.js';
import { parseCalendarDates } from '../src/spec/calendar_dates.js';

describe('parseCalendar', () => {
  it('parses weekly service patterns', async () => {
    const csv = [
      'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date',
      'S1,1,1,1,1,1,0,0,20260101,20261231',
      'S2,0,0,0,0,0,1,1,20260101,20261231',
    ].join('\n');
    const rows = await parseCalendar(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.monday).toBe('1');
    expect(rows[0]?.saturday).toBe('0');
  });
});

describe('parseCalendarDates', () => {
  it('parses exception entries (service added)', async () => {
    const csv = 'service_id,date,exception_type\nS1,20260704,1';
    const rows = await parseCalendarDates(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.service_id).toBe('S1');
    expect(rows[0]?.exception_type).toBe('1');
  });

  it('parses exception entries (service removed)', async () => {
    const csv = 'service_id,date,exception_type\nS1,20260704,2';
    const rows = await parseCalendarDates(csv);
    expect(rows[0]?.exception_type).toBe('2');
  });
});