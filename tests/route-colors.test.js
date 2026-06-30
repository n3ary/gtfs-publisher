import { describe, it, expect } from 'vitest';

import {
  normalizeColor,
  computeTypeTopColors,
  resolveRouteColor,
  rotateHueOklch,
  oklabDistance,
  resolveRouteColors,
} from '../src/pipeline/lib/route-colors.js';

describe('normalizeColor', () => {
  it('expands 3-char hex to 6-char uppercase', () => {
    expect(normalizeColor('#abc')).toBe('AABBCC');
    expect(normalizeColor('000')).toBe('000000');
  });
  it('uppercases and strips leading #', () => {
    expect(normalizeColor('#abcdef')).toBe('ABCDEF');
    expect(normalizeColor('abcdef')).toBe('ABCDEF');
  });
  it('returns empty string for missing or invalid input', () => {
    expect(normalizeColor(null)).toBe('');
    expect(normalizeColor(undefined)).toBe('');
    expect(normalizeColor('')).toBe('');
    expect(normalizeColor('xxx')).toBe('');
    expect(normalizeColor('#ZZZZZZ')).toBe('');
  });
});

describe('computeTypeTopColors', () => {
  it('returns the most-frequent non-placeholder color per type', () => {
    const rows = [
      { route_type: 3, route_color: '#F3513C' },
      { route_type: 3, route_color: '#F3513C' },
      { route_type: 3, route_color: '#000000' },
      { route_type: 3, route_color: '#0048FF' },
      { route_type: 0, route_color: '#1500FF' },
    ];
    const top = computeTypeTopColors(rows);
    expect(top.get('3')).toBe('F3513C');
    expect(top.get('0')).toBe('1500FF');
  });
  it('omits types whose routes are all placeholder/invalid', () => {
    const rows = [
      { route_type: 11, route_color: '#000' },
      { route_type: 11, route_color: 'xxx' },
      { route_type: 11, route_color: null },
    ];
    const top = computeTypeTopColors(rows);
    expect(top.has('11')).toBe(false);
  });
});

describe('resolveRouteColor', () => {
  it('passes through valid non-placeholder colors', () => {
    const top = new Map([['3', 'F3513C']]);
    expect(resolveRouteColor('#1F807B', '3', top)).toEqual({ color: '1F807B', substitutedFrom: null });
  });
  it("substitutes black sentinel with the type's modal", () => {
    const top = new Map([['3', 'F3513C']]);
    expect(resolveRouteColor('#000', '3', top)).toEqual({ color: 'F3513C', substitutedFrom: 'placeholder' });
    expect(resolveRouteColor('#000000', '3', top)).toEqual({ color: 'F3513C', substitutedFrom: 'placeholder' });
  });
  it("substitutes invalid hex with the type's modal", () => {
    const top = new Map([['3', 'F3513C']]);
    expect(resolveRouteColor('xxx', '3', top)).toEqual({ color: 'F3513C', substitutedFrom: 'invalid' });
    expect(resolveRouteColor(null, '3', top)).toEqual({ color: 'F3513C', substitutedFrom: 'invalid' });
  });
});

describe('rotateHueOklch + oklabDistance', () => {
  it('returns the same color for a 0 degree rotation', () => {
    expect(rotateHueOklch('F3513C', 0)).toBe('F3513C');
  });
  it('produces visually distinct results for 120 degree rotations', () => {
    const a = rotateHueOklch('F3513C', 0);
    const b = rotateHueOklch('F3513C', 120);
    const c = rotateHueOklch('F3513C', 240);
    expect(oklabDistance(a, b)).toBeGreaterThan(0.15);
    expect(oklabDistance(a, c)).toBeGreaterThan(0.15);
    expect(oklabDistance(b, c)).toBeGreaterThan(0.15);
  });
});

describe('resolveRouteColors — already-curated feed (Cluj after adapter)', () => {
  it('reports "no fixes needed" when modals are distinct and no placeholders exist', () => {
    const rows = [
      // Per-type modals are pre-distinct; one-offs are sprinkled in.
      ...Array.from({ length: 4 }, (_, i) => ({ route_id: `T${i}`, route_type: 0, route_color: '#248EFF' })),
      ...Array.from({ length: 142 }, (_, i) => ({ route_id: `B${i}`, route_type: 3, route_color: '#F3513C' })),
      { route_id: 'B-oneoff-1', route_type: 3, route_color: '#693CF3' },
      ...Array.from({ length: 14 }, (_, i) => ({ route_id: `TB${i}`, route_type: 11, route_color: '#00B147' })),
      { route_id: 'TB-oneoff', route_type: 11, route_color: '#1500FF' },
    ];
    const { rows: out, logs } = resolveRouteColors(rows);
    // No row should have changed color.
    for (let i = 0; i < rows.length; i++) {
      expect(out[i].route_color).toBe(rows[i].route_color.slice(1).toUpperCase());
    }
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/no route_color fixes needed/);
  });
});

describe('resolveRouteColors — placeholder substitution', () => {
  it('replaces black/missing route_color with the per-type modal', () => {
    const rows = [
      { route_id: '1', route_type: 3, route_color: '#F3513C' },
      { route_id: '2', route_type: 3, route_color: '#F3513C' },
      { route_id: '3', route_type: 3, route_color: '#000' },
      { route_id: '4', route_type: 3, route_color: null },
    ];
    const { rows: out, logs } = resolveRouteColors(rows);
    for (const r of out) expect(r.route_color).toBe('F3513C');
    expect(logs.some((l) => /placeholder/.test(l))).toBe(true);
    expect(logs.some((l) => /invalid\/missing/.test(l))).toBe(true);
  });
});

describe('resolveRouteColors — modal collision resolution', () => {
  it('skews colliding types via OKLCh rotation; one-offs are preserved', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ route_id: `B${i}`, route_type: 3, route_color: '#F3513C' })),
      ...Array.from({ length: 2 }, (_, i) => ({ route_id: `T${i}`, route_type: 0, route_color: '#F3513C' })),
      // One-off on bus.
      { route_id: 'B-oneoff', route_type: 3, route_color: '#0048FF' },
    ];
    const { rows: out, logs } = resolveRouteColors(rows);
    // Bus has more routes at F3513C than tram → bus keeps the color.
    expect(out.find((r) => r.route_id === 'B0').route_color).toBe('F3513C');
    // Tram routes are reassigned to a single new color, not F3513C.
    const tramColor = out.find((r) => r.route_id === 'T0').route_color;
    expect(tramColor).not.toBe('F3513C');
    expect(out.find((r) => r.route_id === 'T1').route_color).toBe(tramColor);
    // One-off preserved.
    expect(out.find((r) => r.route_id === 'B-oneoff').route_color).toBe('0048FF');
    expect(logs.some((l) => /collision resolved/.test(l))).toBe(true);
  });
});

describe('resolveRouteColors — anchor seeding for feeds with no usable colors', () => {
  it('seeds types with no modal from the #F3513C anchor and skews them apart', () => {
    // Three types, NONE has any usable color. The anchor is used to
    // start, the collision resolver skews them apart. Bus has the
    // most routes so it keeps the anchor; the rest get rotated.
    const rows = [
      { route_id: 'T1', route_type: 0, route_color: '#000' },
      { route_id: 'T2', route_type: 0, route_color: null },
      { route_id: 'B1', route_type: 3, route_color: '#000' },
      { route_id: 'B2', route_type: 3, route_color: '#000' },
      { route_id: 'B3', route_type: 3, route_color: '#000' },
      { route_id: 'TB1', route_type: 11, route_color: null },
    ];
    const { rows: out, logs } = resolveRouteColors(rows);
    const tramColor = out.find((r) => r.route_id === 'T1').route_color;
    const busColor = out.find((r) => r.route_id === 'B1').route_color;
    const trolleyColor = out.find((r) => r.route_id === 'TB1').route_color;
    // All three types end up with a distinct color.
    expect(new Set([tramColor, busColor, trolleyColor]).size).toBe(3);
    // The busiest seeded type (bus, 3 routes) keeps the anchor.
    expect(busColor).toBe('F3513C');
    expect(logs.some((l) => /seeded .* anchor #F3513C/.test(l))).toBe(true);
  });
});
