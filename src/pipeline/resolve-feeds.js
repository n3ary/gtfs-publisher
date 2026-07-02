/**
 * resolve-feeds.js — produce the ordered list of feeds this run will build.
 *
 * Single source of truth: `countries.json`'s `include[]` lists Transitous
 * source names to publish. Each entry becomes either:
 *
 *   - a **plain mirror** of Transitous's resolved zip (default), OR
 *   - a **remote-sourced feed** if a `feeds/<id>/config.json` declares
 *     `enhances: "<TransitousName>"` and a `source.type === "remote"`
 *     pointing at a fully pre-built GTFS zip in another repo
 *     (e.g. cluj-napoca-gtfs-adapter).
 *
 * The override file may also overlay realtime / license / metadata
 * fields on top of either kind of base.
 *
 * Local feed dirs without an `enhances` value (or whose `enhances`
 * doesn't match anything in `include[]`) are warned about and skipped.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson } from './lib/http.js';
import { resolveRealtimeForName } from './lib/mdb-rt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const FEEDS_DIR = join(ROOT, 'feeds');

const TRANSITOUS_RAW = 'https://raw.githubusercontent.com/public-transport/transitous/main/feeds';
const TRANSITOUS_GTFS_BASE = 'https://api.transitous.org/gtfs';

// ───────────────────────────────────────────────────────────────────────────
// Per-feed overrides (auto-discovered from feeds/<id>/config.json)
// ───────────────────────────────────────────────────────────────────────────

function loadOverrides() {
  if (!existsSync(FEEDS_DIR)) return new Map();
  const byTransitousName = new Map();
  for (const entry of readdirSync(FEEDS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(FEEDS_DIR, entry.name, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
    if (!cfg.enhances) {
      console.warn(`[resolve-feeds] feeds/${entry.name}/config.json has no 'enhances' field — skipped.`);
      continue;
    }
    byTransitousName.set(cfg.enhances, { dir: entry.name, cfg });
  }
  return byTransitousName;
}

// ───────────────────────────────────────────────────────────────────────────

async function fetchTransitousCountry(iso) {
  return fetchJson(`${TRANSITOUS_RAW}/${iso}.json`);
}

function defaultSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build a feed object from a Transitous source.
 *
 * Strategy: build the Transitous-derived base once, then if an override
 * is present, overlay only the fields it explicitly sets — single source
 * of truth for "what fields exist" (the base).
 */
function projectFeed(iso, raw, override, mdbRealtime) {
  if (!raw.name) return { skip: 'missing name' };
  if (!['http', 'transitland-atlas', 'mobility-database'].includes(raw.type)) {
    return { skip: `unsupported source type: ${raw.type}` };
  }

  const base = {
    id: defaultSlug(raw.name),
    name: raw.name,
    country: iso.toUpperCase(),
    region: null,
    timezone: null,
    languages: [],
    source: {
      type: 'transitous',
      publisher: `Transitous (${raw.type})`,
      // For mobility-database / transitland-atlas types, ro.json has no
      // direct URL — Transitous's pipeline resolves the canonical URL.
      // We record the API URL fetch-gtfs actually hits.
      upstream_url: raw.url ?? `${TRANSITOUS_GTFS_BASE}/${iso.toLowerCase()}_${encodeURIComponent(raw.name)}.gtfs.zip`,
    },
    agencies: [], // derive-bbox re-reads agency.txt; this is just a placeholder
    realtime: mdbRealtime,
    license: {
      spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
      attribution_text: raw.license?.['attribution-text'] ?? raw.name,
      attribution_url: raw.license?.['url'] ?? null,
    },
  };

  if (!override) return { feed: base };

  const c = override.cfg;

  // The only non-transitous source type currently supported is "remote".
  // Adding a new type would mean adding a new branch in fetch-gtfs.js.
  let source = base.source;
  if (c.source) {
    if (c.source.type !== 'remote') {
      return { skip: `unknown source.type "${c.source.type}" (expected "remote")` };
    }
    if (!c.source.url) {
      return { skip: 'source.type=remote but no source.url' };
    }
    source = {
      type: 'remote',
      publisher: c.source.publisher ?? `remote (${new URL(c.source.url).hostname})`,
      upstream_url: c.source.url,
    };
  }

  return {
    feed: {
      ...base,
      id: c.id ?? override.dir,
      name: c.name ?? base.name,
      country: c.country ?? base.country,
      region: c.region ?? null,
      timezone: c.timezone ?? null,
      languages: c.languages ?? [],
      source,
      realtime: c.realtime ?? mdbRealtime,
      license: {
        spdx_identifier: c.license?.spdx_identifier ?? base.license.spdx_identifier,
        attribution_text: c.license?.attribution_text ?? base.license.attribution_text,
        attribution_url: c.license?.attribution_url ?? base.license.attribution_url,
      },
      _smoke: c.smoke ?? null,
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────

export async function resolveFeeds() {
  const config = JSON.parse(readFileSync(join(ROOT, 'countries.json'), 'utf8'));
  const countries = config.countries ?? [];
  const includeWhitelist = new Set(config.include ?? []);
  const overrides = loadOverrides();

  const feeds = [];
  const seenIds = new Set();
  const matchedOverrides = new Set();

  for (const iso of countries) {
    let payload;
    try {
      payload = await fetchTransitousCountry(iso);
    } catch (err) {
      console.warn(`[resolve-feeds] skipping ${iso}: ${err.message}`);
      continue;
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    for (const raw of sources) {
      if (!includeWhitelist.has(raw.name)) continue;
      // RT siblings are consumed by resolveRealtimeForName below, not
      // emitted as standalone feeds.
      if (raw.spec === 'gtfs-rt') continue;
      const override = overrides.get(raw.name);
      const mdbRealtime = await resolveRealtimeForName(sources, raw.name);
      const projected = projectFeed(iso, raw, override, mdbRealtime);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name}: skipped (${projected.skip})`);
        continue;
      }
      if (seenIds.has(projected.feed.id)) continue;
      seenIds.add(projected.feed.id);
      if (override) matchedOverrides.add(raw.name);
      feeds.push(projected.feed);
    }
  }

  // Warn about orphan overrides — local dirs with enhances:X but X not in include[]
  for (const [name, ov] of overrides) {
    if (!matchedOverrides.has(name)) {
      console.warn(`[resolve-feeds] feeds/${ov.dir}/ enhances "${name}" but that name is not in countries.json include[] — feed will not be published.`);
    }
  }

  const tag = (f) => f.source.type === 'remote' ? '*' : '';
  console.log(`[resolve-feeds] ${feeds.length} feed(s): ${feeds.map((f) => `${f.id}${tag(f)}`).join(', ')}  (* = remote source)`);
  return feeds;
}
