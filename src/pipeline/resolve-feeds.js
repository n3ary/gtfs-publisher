/**
 * resolve-feeds.js — produce the ordered list of feeds this run will build.
 *
 * Single source of truth: `countries.json`'s `include[]` lists Transitous
 * source names to publish. Each entry becomes either:
 *
 *   - a **plain mirror** of Transitous's resolved zip (default), OR
 *   - an **enhanced build** if a `feeds/<id>/config.json` declares
 *     `enhances: "<TransitousName>"`. The Transitous zip is fetched and
 *     passed to the feed's `build.js` as the seed; the script mutates it
 *     and writes the final `outputs/feeds/<id>.gtfs.zip`.
 *
 * Local feed dirs without an `enhances` value (or whose `enhances`
 * doesn't match anything in `include[]`) are warned about and skipped —
 * the model is: include[] decides what to publish, feeds/<id>/ decides
 * how to enhance.
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
// Local enhancement layers (auto-discovered from feeds/<id>/config.json)
// ───────────────────────────────────────────────────────────────────────────

function loadEnhancers() {
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
 * Strategy: build the Transitous-derived base once, then if an enhancer
 * is present, overlay only the fields it explicitly sets — single source
 * of truth for "what fields exist" (the base).
 */
function projectFeed(iso, raw, enhancer, mdbRealtime) {
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
    tranzy: null,
    license: {
      spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
      attribution_text: raw.license?.['attribution-text'] ?? raw.name,
      attribution_url: raw.license?.['url'] ?? null,
    },
  };

  if (!enhancer) return { feed: base };

  // Overlay enhancer fields. Each one is "??" — config supplies wins,
  // otherwise inherit from Transitous base.
  const c = enhancer.cfg;
  return {
    feed: {
      ...base,
      id: c.id ?? enhancer.dir,
      name: c.name ?? base.name,
      country: c.country ?? base.country,
      region: c.region ?? null,
      timezone: c.timezone ?? null,
      languages: c.languages ?? [],
      source: {
        type: 'build',
        publisher: 'neary-gtfs',
        upstream_url: `${TRANSITOUS_GTFS_BASE}/${iso.toLowerCase()}_${encodeURIComponent(raw.name)}.gtfs.zip`,
      },
      realtime: c.realtime ?? mdbRealtime,
      tranzy: c.tranzy ?? null,
      license: {
        spdx_identifier: c.license?.spdx_identifier ?? base.license.spdx_identifier,
        attribution_text: c.license?.attribution_text ?? base.license.attribution_text,
        attribution_url: c.license?.attribution_url ?? base.license.attribution_url,
      },
      _enhances: { iso, transitousName: raw.name, feedDir: enhancer.dir },
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────

export async function resolveFeeds() {
  const config = JSON.parse(readFileSync(join(ROOT, 'countries.json'), 'utf8'));
  const countries = config.countries ?? [];
  const includeWhitelist = new Set(config.include ?? []);
  const enhancers = loadEnhancers();

  const feeds = [];
  const seenIds = new Set();
  const matchedEnhancers = new Set();

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
      const enhancer = enhancers.get(raw.name);
      const mdbRealtime = await resolveRealtimeForName(sources, raw.name);
      const projected = projectFeed(iso, raw, enhancer, mdbRealtime);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name}: skipped (${projected.skip})`);
        continue;
      }
      if (seenIds.has(projected.feed.id)) continue;
      seenIds.add(projected.feed.id);
      if (enhancer) matchedEnhancers.add(raw.name);
      feeds.push(projected.feed);
    }
  }

  // Warn about orphan enhancers — local dirs with enhances:X but X not in include[]
  for (const [name, enh] of enhancers) {
    if (!matchedEnhancers.has(name)) {
      console.warn(`[resolve-feeds] feeds/${enh.dir}/ enhances "${name}" but that name is not in countries.json include[] — feed will not be published.`);
    }
  }

  console.log(`[resolve-feeds] ${feeds.length} feed(s): ${feeds.map((f) => `${f.id}${f._enhances ? '*' : ''}`).join(', ')}  (* = locally enhanced)`);
  return feeds;
}


