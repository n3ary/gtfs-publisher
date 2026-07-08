import { describe, it, expect } from 'vitest';
import { DAY_KEY_COLS, type DayKey, CalendarRowSchema } from '../src/spec/calendar.js';

describe('DAY_KEY_COLS', () => {
  it('lists the 7 GTFS calendar day-of-week columns in Monday-first order', () => {
    expect(DAY_KEY_COLS).toEqual([
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ]);
  });

  it('indexes match `Date.getDay()` after the +6 % 7 conversion', () => {
    // 0 = Sunday in Date.getDay(). 6 = Saturday.
    // After (dow + 6) % 7: 0 -> 6 (sunday), 1 -> 0 (monday), ..., 6 -> 5 (saturday).
    expect(DAY_KEY_COLS[((0 + 6) % 7) as DayKey extends string ? number : never]).toBe('sunday');
    expect(DAY_KEY_COLS[((1 + 6) % 7) as DayKey extends string ? number : never]).toBe('monday');
    expect(DAY_KEY_COLS[((2 + 6) % 7) as DayKey extends string ? number : never]).toBe('tuesday');
    expect(DAY_KEY_COLS[((6 + 6) % 7) as DayKey extends string ? number : never]).toBe('saturday');
  });

  it('every entry is a key in CalendarRowSchema.shape', () => {
    const shape = CalendarRowSchema.shape;
    for (const k of DAY_KEY_COLS) {
      expect(shape[k]).toBeDefined();
    }
  });
});
