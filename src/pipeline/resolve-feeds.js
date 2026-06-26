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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const FEEDS_DIR = join(ROOT, 'feeds');

const TRANSITOUS_RAW = 'https://raw.githubusercontent.com/public-transport/transitous/main/feeds';

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
  const url = `${TRANSITOUS_RAW}/${iso}.json`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'neary-gtfs/2.0 (https://github.com/ciotlosm/neary-gtfs)' },
  });
  if (!res.ok) throw new Error(`Transitous fetch failed for ${iso}: HTTP ${res.status}`);
  return res.json();
}

function defaultSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build a feed object from a Transitous source, optionally promoted to
 * a local enhancement build.
 */
function projectFeed(iso, raw, enhancer) {
  if (!raw.name) return { skip: 'missing name' };
  if (!['http', 'transitland-atlas', 'mobility-database'].includes(raw.type)) {
    return { skip: `unsupported source type: ${raw.type}` };
  }

  // Common Transitous metadata
  const transitousFallback = {
    id: defaultSlug(raw.name),
    name: raw.name,
    country: iso.toUpperCase(),
    region: null,
    timezone: null,
    languages: [],
    realtime: null,
    tranzy: null,
    license: {
      spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
      attribution_text: raw.license?.['attribution-text'] ?? raw.name,
      attribution_url: raw.license?.['url'] ?? null,
    },
  };

  if (enhancer) {
    // Local enhancement layer overlays the Transitous metadata. The
    // enhancer only needs to declare what it changes; everything else
    // (name, country, license.spdx_identifier, ...) falls through.
    const c = enhancer.cfg;
    return {
      feed: {
        id: c.id ?? enhancer.dir,
        name: c.name ?? transitousFallback.name,
        country: c.country ?? transitousFallback.country,
        region: c.region ?? null,
        timezone: c.timezone ?? null,
        languages: c.languages ?? [],
        source: {
          type: 'build',
          publisher: 'neary-gtfs',
          upstream_url: `https://api.transitous.org/gtfs/${iso.toLowerCase()}_${encodeURIComponent(raw.name)}.gtfs.zip`,
        },
        agencies: [], // derive-bbox re-reads agency.txt from the built zip
        realtime: c.realtime ?? null,
        tranzy: c.tranzy ?? null,
        license: {
          spdx_identifier: c.license?.spdx_identifier ?? transitousFallback.license.spdx_identifier,
          attribution_text: c.license?.attribution_text ?? transitousFallback.license.attribution_text,
          attribution_url: c.license?.attribution_url ?? transitousFallback.license.attribution_url,
        },
        // pipeline-internal: tells fetch-gtfs to seed the build from Transitous
        _enhances: { iso, transitousName: raw.name, feedDir: enhancer.dir },
      },
    };
  }

  return {
    feed: {
      ...transitousFallback,
      source: {
        type: 'transitous',
        publisher: `Transitous (${raw.type})`,
        upstream_url: raw.url ?? null,
      },
      agencies: [],
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
      const enhancer = enhancers.get(raw.name);
      const projected = projectFeed(iso, raw, enhancer);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name}: skipped (${projected.skip})`);
        continue;
      }
      // include[] may match the same name multiple times (e.g. Bucuresti-Ilfov
      // has 4 mdb-id entries) — Transitous serves the same canonical URL
      // for all, so emit once.
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


