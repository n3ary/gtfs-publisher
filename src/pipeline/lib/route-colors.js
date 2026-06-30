/**
 * Route-color quirk fixer for arbitrary GTFS feeds.
 *
 * Many feeds publish route_color values that carry little per-route
 * signal — routes ship as #000 (a "no preference" sentinel), entire
 * modes share the same color, or values aren't valid hex. This module
 * normalizes those cases so every feed neary-gtfs ingests ends up
 * with distinct, readable route colors regardless of producer hygiene:
 *
 *   1. Black/missing/invalid `route_color` → substituted with the
 *      per-type modal color (most-frequent valid color of that
 *      route_type in the feed).
 *   2. Types with no usable color get seeded from a deterministic
 *      anchor (#F3513C) and skewed apart by the collision resolver.
 *   3. When two route_types resolve to the same modal, the type with
 *      the most routes at that color keeps it; the rest are rotated
 *      around the OKLCh hue wheel (`i·360°/N`), then nudged in ±15°
 *      steps to stay ≥ 0.15 OKLab away from any existing one-off
 *      color or previously-assigned modal.
 *   4. One-off route colors (a single route painted differently from
 *      its mode's modal) are preserved verbatim.
 *
 * Feeds that already arrive well-curated trigger no substitutions and
 * no skews — the log line is just "no fixes needed".
 */

/** Normalize a color value to the GTFS-spec `Color` type: 6-char hex,
 *  uppercased, no leading `#`. Accepts shorthand (`'#abc'` → `'AABBCC'`),
 *  full hex (`'#abcdef'` → `'ABCDEF'`), returns `''` for empty/invalid.
 *  Per https://gtfs.org/documentation/schedule/reference/#field-types */
export function normalizeColor(raw) {
  let c = (raw ?? '').toString().replace(/^#?/, '').toUpperCase();
  if (c.length === 3 && /^[0-9A-F]{3}$/.test(c)) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  return /^[0-9A-F]{6}$/.test(c) ? c : '';
}

// "No preference" sentinels some producers emit instead of leaving
// route_color empty. Treated as missing and substituted with the type's
// modal color downstream.
const KNOWN_PLACEHOLDER_COLORS = new Set(['000000']);

// Anchor used when a route_type has no usable (non-placeholder) color
// anywhere in the feed. The collision resolver skews other types away
// from this anchor automatically.
const ANCHOR_COLOR = 'F3513C';

// Minimum OKLab distance a skewed modal must keep from every special
// one-off color and every other assigned modal. 0.15 = "clearly
// different colors" threshold.
const OKLAB_DISTINCT_THRESHOLD = 0.15;

/** For each `route_type`, find the most-frequent non-placeholder color
 *  in the feed. Returns Map<typeString, color>. Types whose routes are
 *  all placeholder/missing/invalid are omitted — callers can seed
 *  those from the anchor. */
export function computeTypeTopColors(rows) {
  const counts = new Map();
  for (const r of rows ?? []) {
    if (r.route_type == null || r.route_type === '') continue;
    const color = normalizeColor(r.route_color);
    if (!color || KNOWN_PLACEHOLDER_COLORS.has(color)) continue;
    const type = String(r.route_type);
    if (!counts.has(type)) counts.set(type, new Map());
    const inner = counts.get(type);
    inner.set(color, (inner.get(color) ?? 0) + 1);
  }
  const top = new Map();
  for (const [type, inner] of counts) {
    let bestColor = '';
    let bestCount = 0;
    for (const [color, n] of inner) {
      if (n > bestCount) { bestCount = n; bestColor = color; }
    }
    if (bestColor) top.set(type, bestColor);
  }
  return top;
}

/** Resolve a single row's route_color. Substitution returns the type's
 *  modal; non-placeholder values pass through normalized. */
export function resolveRouteColor(rawColor, routeType, typeTopColors) {
  const normalized = normalizeColor(rawColor);
  if (normalized && !KNOWN_PLACEHOLDER_COLORS.has(normalized)) {
    return { color: normalized, substitutedFrom: null };
  }
  const typeTop = typeTopColors.get(routeType);
  if (!typeTop) {
    return { color: normalized, substitutedFrom: null };
  }
  return {
    color: typeTop,
    substitutedFrom: KNOWN_PLACEHOLDER_COLORS.has(normalized) ? 'placeholder' : 'invalid',
  };
}

// === OKLab / OKLCh helpers ================================================
// Björn Ottosson's OKLab is a perceptually uniform color space; rotating
// hue in OKLCh changes the perceived color family while keeping lightness
// and chroma identical, so white text retains contrast and the output is
// a genuinely different hue rather than a tint/shade.
// https://bottosson.github.io/posts/oklab/

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function rgbToHex([r, g, b]) {
  return [r, g, b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c) {
  const clamped = Math.max(0, Math.min(1, c));
  const v = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return v * 255;
}

function rgbToOklab([R, G, B]) {
  const r = srgbToLinear(R);
  const g = srgbToLinear(G);
  const b = srgbToLinear(B);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const lin_l = l_ ** 3;
  const lin_m = m_ ** 3;
  const lin_s = s_ ** 3;
  return [
    linearToSrgb( 4.0767416621 * lin_l - 3.3077115913 * lin_m + 0.2309699292 * lin_s),
    linearToSrgb(-1.2684380046 * lin_l + 2.6097574011 * lin_m - 0.3413193965 * lin_s),
    linearToSrgb(-0.0041960863 * lin_l - 0.7034186147 * lin_m + 1.7076147010 * lin_s),
  ];
}

export function rotateHueOklch(hex, degrees) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  const C = Math.sqrt(a * a + b * b);
  const h = Math.atan2(b, a) + (degrees * Math.PI) / 180;
  return rgbToHex(oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)]));
}

export function oklabDistance(hexA, hexB) {
  const [La, aa, ba] = rgbToOklab(hexToRgb(hexA));
  const [Lb, ab, bb] = rgbToOklab(hexToRgb(hexB));
  const dL = La - Lb;
  const da = aa - ab;
  const db = ba - bb;
  return Math.sqrt(dL * dL + da * da + db * db);
}

function findSafeRotation(baseColor, idealDegrees, forbiddenColors) {
  const candidates = [idealDegrees];
  for (let off = 15; off <= 180; off += 15) {
    candidates.push(idealDegrees + off);
    candidates.push(idealDegrees - off);
  }
  const forbidden = [...forbiddenColors].filter(Boolean);
  let bestColor = null;
  let bestDegrees = idealDegrees;
  let bestMinDist = -Infinity;
  for (const deg of candidates) {
    const candidate = rotateHueOklch(baseColor, deg);
    const minDist = forbidden.length === 0
      ? Infinity
      : Math.min(...forbidden.map((fc) => oklabDistance(candidate, fc)));
    if (minDist >= OKLAB_DISTINCT_THRESHOLD) {
      return { color: candidate, degrees: deg };
    }
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      bestColor = candidate;
      bestDegrees = deg;
    }
  }
  return { color: bestColor ?? rotateHueOklch(baseColor, idealDegrees), degrees: bestDegrees };
}

/** Group typeTopColors by color; for each group of 2+, sort by route
 *  count desc (busiest type keeps the color) and rotate the rest around
 *  the OKLCh wheel by `i·360°/N`, with avoidance of any existing
 *  forbidden color. Mutates typeTopColors and returns the skew list. */
export function resolveModalCollisions(typeTopColors, routeCountAtModal, allRouteColors) {
  const byColor = new Map();
  for (const [type, color] of typeTopColors) {
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(type);
  }
  const skews = [];
  for (const [color, types] of byColor) {
    if (types.length < 2) continue;
    types.sort(
      (a, b) =>
        (routeCountAtModal.get(b) ?? 0) - (routeCountAtModal.get(a) ?? 0) ||
        Number(a) - Number(b),
    );
    const N = types.length;
    const step = 360 / N;
    const forbidden = new Set([...allRouteColors].filter((c) => c && c !== color));
    for (let i = 1; i < N; i++) {
      const { color: newColor } = findSafeRotation(color, i * step, forbidden);
      typeTopColors.set(types[i], newColor);
      forbidden.add(newColor);
      skews.push({ type: types[i], fromColor: color, toColor: newColor });
    }
  }
  return skews;
}

/**
 * Compute a perceptually distinct hex color for each network, derived
 * from the modal route_color of routes in that network. Applies the
 * same OKLCh collision resolution used for route_type modals so every
 * chip reads at a distinct hue regardless of how many networks share
 * their routes' dominant color.
 *
 * @param {Array} routeRows        routes.txt rows (route_id, route_color)
 * @param {Array} routeNetworkRows route_networks.txt rows (route_id, network_id)
 * @param {Array} networkRows      networks.txt rows (network_id)
 * @returns {Map<string, string>}  network_id → 6-char uppercase hex (no leading #)
 */
export function computeNetworkColors(routeRows, routeNetworkRows, networkRows) {
  // Build a lookup of valid route colors (normalized, non-placeholder).
  const colorByRoute = new Map();
  for (const r of routeRows ?? []) {
    const c = normalizeColor(r.route_color);
    if (c && !KNOWN_PLACEHOLDER_COLORS.has(c)) colorByRoute.set(r.route_id, c);
  }

  // Count each color's occurrences per network.
  const countsByNetwork = new Map(); // networkId → Map<color, count>
  for (const rn of routeNetworkRows ?? []) {
    const color = colorByRoute.get(rn.route_id);
    if (!color) continue;
    if (!countsByNetwork.has(rn.network_id)) countsByNetwork.set(rn.network_id, new Map());
    const inner = countsByNetwork.get(rn.network_id);
    inner.set(color, (inner.get(color) ?? 0) + 1);
  }

  // Modal color per network (most frequent).
  const modalColors = new Map(); // networkId → color
  const countAtModal = new Map(); // networkId → count at modal
  for (const [netId, counts] of countsByNetwork) {
    let best = '', bestN = 0;
    for (const [color, n] of counts) {
      if (n > bestN) { best = color; bestN = n; }
    }
    if (best) { modalColors.set(netId, best); countAtModal.set(netId, bestN); }
  }

  // Seed networks with no usable route colors from the anchor.
  for (const n of networkRows ?? []) {
    if (!modalColors.has(n.network_id)) modalColors.set(n.network_id, ANCHOR_COLOR);
  }

  // Resolve collisions: ≥2 networks sharing the same modal get rotated.
  const allColors = new Set(modalColors.values());
  const byColor = new Map();
  for (const [netId, color] of modalColors) {
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(netId);
  }
  for (const [baseColor, group] of byColor) {
    if (group.length < 2) continue;
    group.sort((a, b) => (countAtModal.get(b) ?? 0) - (countAtModal.get(a) ?? 0));
    const step = 360 / group.length;
    const forbidden = new Set([...allColors].filter((c) => c !== baseColor));
    for (let i = 1; i < group.length; i++) {
      const idealDeg = i * step;
      const candidates = [idealDeg];
      for (let off = 15; off <= 180; off += 15) candidates.push(idealDeg + off, idealDeg - off);
      let newColor = rotateHueOklch(baseColor, idealDeg);
      for (const deg of candidates) {
        const c = rotateHueOklch(baseColor, deg);
        const minDist = [...forbidden].reduce((mn, fc) => Math.min(mn, oklabDistance(c, fc)), Infinity);
        if (minDist >= OKLAB_DISTINCT_THRESHOLD) { newColor = c; break; }
      }
      modalColors.set(group[i], newColor);
      allColors.add(newColor);
      forbidden.add(newColor);
    }
  }

  return modalColors; // network_id → 6-char hex (uppercase, no #)
}

// Friendly labels for the most common route_type integers. Anything not
// listed is shown as `type=<N>` in the log lines.
const TYPE_LABELS = {
  0: 'tram', 1: 'metro', 2: 'rail', 3: 'bus', 4: 'ferry',
  5: 'cablecar', 6: 'gondola', 7: 'funicular',
  11: 'trolleybus', 12: 'monorail',
};

function typeLabel(t) {
  return TYPE_LABELS[Number(t)] ?? `type=${t}`;
}

/**
 * Main entry point. Apply the full color-quirk fixup to a routes.txt
 * row set.
 *
 * @param {Array<{route_id?: string, route_type?: string|number, route_color?: string}>} rows
 * @returns {{ rows: Array, logs: string[] }}
 */
export function resolveRouteColors(rows) {
  const logs = [];
  if (!Array.isArray(rows) || rows.length === 0) return { rows: rows ?? [], logs };

  // 1. Per-type modal from input (excludes placeholder/missing).
  const typeTopColors = computeTypeTopColors(rows);

  // 2. Seed types-with-no-modal from the anchor. The collision resolver
  //    below skews them apart from each other and from existing modals.
  const typesPresent = new Set();
  for (const r of rows) {
    if (r.route_type != null && r.route_type !== '') {
      typesPresent.add(String(r.route_type));
    }
  }
  const seededTypes = [];
  for (const t of typesPresent) {
    if (!typeTopColors.has(t)) {
      typeTopColors.set(t, ANCHOR_COLOR);
      seededTypes.push(t);
    }
  }

  // 3. Substitute placeholder/invalid colors with their type's modal.
  const colorSubstitutions = new Map();
  const tallySub = (routeType, reason) => {
    if (!colorSubstitutions.has(routeType)) {
      colorSubstitutions.set(routeType, { placeholder: 0, invalid: 0 });
    }
    colorSubstitutions.get(routeType)[reason]++;
  };
  const transformed = rows.map((r) => {
    const routeType = String(r.route_type ?? '');
    const { color, substitutedFrom } = resolveRouteColor(r.route_color, routeType, typeTopColors);
    if (substitutedFrom) tallySub(routeType, substitutedFrom);
    // Pass through whatever normalizeColor produced if no substitution
    // happened — for non-empty inputs that returns a 6-char uppercase
    // hex, which is what we want to write to SQLite. For genuinely
    // empty inputs that can't be normalized, leave the field empty.
    return { ...r, route_color: color };
  });

  // 4. Collision resolution + back-fill. Counts and `allRouteColors`
  //    are taken from the post-substitution rows so the busiest type
  //    at the colliding color is identified correctly.
  const allRouteColors = new Set();
  const routeCountAtModal = new Map();
  for (const r of transformed) {
    if (r.route_color) allRouteColors.add(r.route_color);
    const type = String(r.route_type ?? '');
    const modal = typeTopColors.get(type);
    if (modal && r.route_color === modal) {
      routeCountAtModal.set(type, (routeCountAtModal.get(type) ?? 0) + 1);
    }
  }
  const skews = resolveModalCollisions(typeTopColors, routeCountAtModal, allRouteColors);
  if (skews.length > 0) {
    const skewByType = new Map(skews.map((s) => [s.type, s]));
    for (const r of transformed) {
      const type = String(r.route_type ?? '');
      const skew = skewByType.get(type);
      if (skew && r.route_color === skew.fromColor) {
        r.route_color = skew.toColor;
      }
    }
  }

  // 5. Logs.
  const renderBreakdown = (reason) => {
    const parts = [...colorSubstitutions.entries()]
      .filter(([, counts]) => counts[reason] > 0)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([type, counts]) => `${counts[reason]} ${typeLabel(type)} → #${typeTopColors.get(type)}`);
    return parts.length > 0 ? parts.join(', ') : null;
  };
  const placeholderBreakdown = renderBreakdown('placeholder');
  if (placeholderBreakdown) {
    logs.push(`substituted placeholder route_color with modal per-type color — ${placeholderBreakdown}`);
  }
  const invalidBreakdown = renderBreakdown('invalid');
  if (invalidBreakdown) {
    logs.push(`substituted invalid/missing route_color with modal per-type color — ${invalidBreakdown}`);
  }
  if (seededTypes.length > 0) {
    const parts = seededTypes
      .sort((a, b) => Number(a) - Number(b))
      .map((t) => `${typeLabel(t)} → #${typeTopColors.get(t)}`);
    logs.push(`seeded ${seededTypes.length} route_type(s) with no usable color from anchor #${ANCHOR_COLOR} — ${parts.join(', ')}`);
  }
  if (skews.length > 0) {
    const parts = skews.map((s) => `${typeLabel(s.type)} #${s.fromColor} → #${s.toColor}`);
    logs.push(`modal route_color collision resolved by OKLCh hue rotation — ${parts.join(', ')}`);
  }
  if (logs.length === 0) {
    logs.push('no route_color fixes needed — feed arrived with distinct per-type modals and no placeholders');
  }

  return { rows: transformed, logs };
}
