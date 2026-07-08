/**
 * resolve-feeds.ts — produce the ordered list of feeds this run will build.
 *
 * Single source of truth: `countries.json`'s `include[]` lists Transitous
 * source names to publish. Each entry becomes either:
 *
 *   - a **plain mirror** of Transitous's resolved zip (default), OR
 *   - a **remote-sourced feed** if a `feeds/<id>/config.json` declares
 *     `enhances: "<TransitousName>"` and a `source.type === "remote"`
 *     pointing at a fully pre-built GTFS zip in another repo, OR
 *   - an **adapter-driven feed** if a `feeds/<id>/config.json` declares
 *     `source.type === "adapter"` and a `source.publisher` naming the
 *     adapter package (e.g. `@n3ary/gtfs-adapter-<feed>`).
 *
 * The override file may also overlay realtime / license / metadata
 * fields on top of any kind of base.
 *
 * Local feed dirs without an `enhances` value (or whose `enhances`
 * doesn't match anything in `include[]`) are warned about and skipped.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchJson } from './lib/http.js';
import { resolveRealtimeForName } from './lib/mdb-rt.js';
import type { Feed, License, Realtime } from './lib/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root — where per-feed author configs live at <ROOT>/feeds/<id>/config.json.
const ROOT = join(__dirname, '..', '..', '..');
const FEEDS_DIR = join(ROOT, 'feeds');
// The static-pipeline-private countries roster stays with the static
// pipeline. It's a build-time input (which Transitous source names
// to publish), not a per-feed authored artifact, and the rt app
// doesn't read it.
const COUNTRIES_JSON = join(__dirname, '..', 'countries.json');

const TRANSITOUS_RAW = 'https://raw.githubusercontent.com/public-transport/transitous/main/feeds';
const TRANSITOUS_GTFS_BASE = 'https://api.transitous.org/gtfs';

// ───────────────────────────────────────────────────────────────────────────
// Per-feed overrides (auto-discovered from feeds/<id>/config.json)
// ───────────────────────────────────────────────────────────────────────────

type Override = { dir: string; cfg: Record<string, unknown> };

function loadOverrides(): Map<string, Override> {
  if (!existsSync(FEEDS_DIR)) return new Map();
  const byTransitousName = new Map<string, Override>();
  for (const entry of readdirSync(FEEDS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(FEEDS_DIR, entry.name, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    if (!cfg.enhances) {
      console.warn(`[resolve-feeds] feeds/${entry.name}/config.json has no 'enhances' field — skipped.`);
      continue;
    }
    byTransitousName.set(cfg.enhances as string, { dir: entry.name, cfg });
  }
  return byTransitousName;
}

// ───────────────────────────────────────────────────────────────────────────

async function fetchTransitousCountry(iso: string): Promise<{ sources?: RawTransitousSource[] }> {
  return (await fetchJson(`${TRANSITOUS_RAW}/${iso}.json`)) as { sources?: RawTransitousSource[] };
}

type RawTransitousSource = {
  name?: string;
  type?: string;
  spec?: string;
  url?: string;
  license?: { 'spdx-identifier'?: string; 'attribution-text'?: string; url?: string };
};

function defaultSlug(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build a feed object from a Transitous source.
 *
 * Strategy: build the Transitous-derived base once, then if an override
 * is present, overlay only the fields it explicitly sets — single source
 * of truth for "what fields exist" (the base).
 */
function projectFeed(iso: string, raw: RawTransitousSource, override: Override | undefined, mdbRealtime: Realtime | null): Promise<{ skip?: string; feed?: Feed }> {
  return projectFeedImpl(iso, raw, override, mdbRealtime);
}

async function projectFeedImpl(iso: string, raw: RawTransitousSource, override: Override | undefined, mdbRealtime: Realtime | null): Promise<{ skip?: string; feed?: Feed }> {
  if (!raw.name) return { skip: 'missing name' };
  if (!['http', 'transitland-atlas', 'mobility-database'].includes(raw.type ?? '')) {
    return { skip: `unsupported source type: ${raw.type}` };
  }

  const baseLicense: License = {
    spdx_identifier: raw.license?.['spdx-identifier'] ?? null,
    attribution_text: raw.license?.['attribution-text'] ?? raw.name,
    attribution_url: raw.license?.url ?? null,
  };

  const base: Feed = {
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
    license: baseLicense,
  };

  if (!override) return { feed: base };

  const c = override.cfg as {
    id?: string; name?: string; country?: string; region?: string;
    timezone?: string; languages?: string[]; realtime?: Realtime;
    source?: { type?: string; publisher?: string; url?: string };
    license?: { spdx_identifier?: string; attribution_text?: string; attribution_url?: string };
    smoke?: { expectedPublisher?: string; tripIdPattern?: string };
  };

  // Non-transitous source types:
  //   - "remote"  → upstream URL to fetch (legacy / external adapter repo)
  //   - "adapter" → invoke an adapter package's ingestBuild (single-
  //     publisher architecture; the adapter's published zip replaces
  //     the upstream URL entirely — upstream_url stays null).
  let source = base.source;
  if (c.source) {
    const t = c.source.type;
    if (t === 'remote') {
      if (!c.source.url) {
        return { skip: 'source.type=remote but no source.url' };
      }
      source = {
        type: 'remote',
        publisher: c.source.publisher ?? `remote (${new URL(c.source.url).hostname})`,
        upstream_url: c.source.url,
      };
    } else if (t === 'adapter') {
      // upstream_url is irrelevant — adapter.ingestBuild produces the zip.
      source = {
        type: 'adapter',
        publisher: c.source.publisher ?? 'adapter',
        upstream_url: null,
      };
    } else {
      return { skip: `unknown source.type "${t}" (expected "remote" or "adapter")` };
    }
  }

  // Realtime URL resolution -- MERGE, not replace:
  //   - mdbRealtime is the base. It carries the canonical
  //     `vehicle_positions` / `trip_updates` / `service_alerts`
  //     URLs auto-discovered from the MDB catalog (works for
  //     transitous + mobility-database + adapter feeds whose
  //     Transitous entry has RT siblings with mdb-id).
  //   - c.realtime is per-feed override. It can override any
  //     individual field (e.g. operator redirects the canonical
  //     URL to a different host) and supplies the
  //     `extra_vehicle_positions` array.
  //   - For adapter-type feeds, the adapter's
  //     `/rt.extraVehiclePositions()` is the per-feed canonical
  //     source for the extras array; per-feed config still
  //     wins if it sets the field explicitly.
  //
  // We MERGE the layers (c.realtime fields override mdbRealtime
  // fields, not replace the whole object) so dropping the
  // canonical URLs from the per-feed config means mdbRealtime
  // supplies them.
  let realtime: Realtime = { ...(mdbRealtime ?? {}) };
  if (c.realtime) {
    realtime = { ...realtime, ...c.realtime };
  }
  if (source.type === 'adapter' && source.publisher) {
    const adapterExtras = await loadAdapterExtras(source.publisher);
    if (adapterExtras !== null) {
      const cfgExtras = realtime.extra_vehicle_positions;
      realtime = {
        ...realtime,
        // Per-feed config's value (if explicitly set) wins; the
        // adapter's value is the default. `[]` is a valid
        // operator-set value meaning "no extras", and it wins
        // over the adapter's contribution too.
        extra_vehicle_positions: cfgExtras !== undefined ? cfgExtras : adapterExtras,
      };
    }
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
      realtime,
      license: {
        spdx_identifier: c.license?.spdx_identifier ?? base.license.spdx_identifier,
        attribution_text: c.license?.attribution_text ?? base.license.attribution_text,
        attribution_url: c.license?.attribution_url ?? base.license.attribution_url,
      },
      _smoke: c.smoke ?? null,
    },
  };
}

/**
 * Try to load extra vehicle_positions URLs from the adapter's
 * `/rt` subpath. Returns null if the adapter doesn't export an
 * `extraVehiclePositions()` function, or if the dynamic import
 * fails. Cached per publisher. Safe to call against cluj 0.3.5
 * (no export) — the function is missing, this returns null, the
 * per-feed config value is used as the source of truth.
 */
const adapterExtrasCache = new Map<string, string[] | null>();
async function loadAdapterExtras(publisher: string): Promise<string[] | null> {
  const hit = adapterExtrasCache.get(publisher);
  if (hit !== undefined) return hit;

  try {
    const mod: any = await import(`${publisher}/rt`);
    if (typeof mod.extraVehiclePositions !== 'function') {
      adapterExtrasCache.set(publisher, null);
      return null;
    }
    const extras = mod.extraVehiclePositions() as string[];
    adapterExtrasCache.set(publisher, extras);
    return extras;
  } catch (err) {
    console.warn(`[resolve-feeds] ${publisher}/rt: extraVehiclePositions() lookup failed -- ${(err as Error).message}`);
    adapterExtrasCache.set(publisher, null);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────

export async function resolveFeeds(): Promise<Feed[]> {
  const config = JSON.parse(readFileSync(COUNTRIES_JSON, 'utf8')) as {
    countries?: string[];
    include?: string[];
  };
  const countries = config.countries ?? [];
  const includeWhitelist = new Set(config.include ?? []);
  const overrides = loadOverrides();

  const feeds: Feed[] = [];
  const seenIds = new Set<string>();
  const matchedOverrides = new Set<string>();

  for (const iso of countries) {
    let payload: { sources?: RawTransitousSource[] };
    try {
      payload = await fetchTransitousCountry(iso);
    } catch (err) {
      console.warn(`[resolve-feeds] skipping ${iso}: ${(err as Error).message}`);
      continue;
    }
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    for (const raw of sources) {
      if (!raw.name || !includeWhitelist.has(raw.name)) continue;
      // RT siblings are consumed by resolveRealtimeForName below, not
      // emitted as standalone feeds.
      if (raw.spec === 'gtfs-rt') continue;
      const override = overrides.get(raw.name);
      const mdbRealtime = await resolveRealtimeForName(sources as Parameters<typeof resolveRealtimeForName>[0], raw.name);
      const projected = await projectFeed(iso, raw, override, mdbRealtime);
      if (projected.skip) {
        console.warn(`[resolve-feeds] ${iso}/${raw.name}: skipped (${projected.skip})`);
        continue;
      }
      if (seenIds.has(projected.feed!.id)) continue;
      seenIds.add(projected.feed!.id);
      if (override) matchedOverrides.add(raw.name);
      feeds.push(projected.feed!);
    }
  }

  // Warn about orphan overrides — local dirs with enhances:X but X not in include[]
  for (const [name, ov] of overrides) {
    if (!matchedOverrides.has(name)) {
      console.warn(`[resolve-feeds] feeds/${ov.dir}/ enhances "${name}" but that name is not in countries.json include[] — feed will not be published.`);
    }
  }

  const tag = (f: Feed) => f.source.type === 'remote' ? '*' : '';
  console.log(`[resolve-feeds] ${feeds.length} feed(s): ${feeds.map((f) => `${f.id}${tag(f)}`).join(', ')}  (* = remote source)`);
  return feeds;
}