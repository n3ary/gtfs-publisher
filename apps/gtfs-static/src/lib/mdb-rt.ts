/**
 * mdb-rt.ts — resolve GTFS-RT URLs for a feed via MobilityData's catalog.
 *
 * Transitous's `ro.json` lists RT feeds as siblings (same `name`,
 * `spec: "gtfs-rt"`, with an `mdb-id`). The mdb-id points at a catalog
 * file under https://github.com/MobilityData/mobility-database-catalogs
 * (`catalogs/sources/gtfs/realtime/<provider-slug>-rt-<type>-<id>.json`),
 * which carries the actual `urls.direct_download`.
 *
 * We resolve in two steps:
 *   1. Fetch the repo's git tree once (single API call, cached for the
 *      lifetime of the pipeline run) → list of all RT catalog filenames.
 *   2. For each mdb-id we care about, find the file ending in `-<id>.json`,
 *      fetch its JSON, read `urls.direct_download` + `entity_type`.
 *
 * Maps the catalog's entity_type codes to our realtime field names:
 *   vp → vehicle_positions
 *   tu → trip_updates
 *   sa → service_alerts
 *
 * Auth: optionally honors GITHUB_TOKEN (set in CI for higher rate limit).
 * Without a token: 60 requests/hour to api.github.com — well under our
 * 1-call-per-run usage.
 */

const TREE_URL = 'https://api.github.com/repos/MobilityData/mobility-database-catalogs/git/trees/main?recursive=1';
const RAW_BASE = 'https://raw.githubusercontent.com/MobilityData/mobility-database-catalogs/main';

const ENTITY_TYPE_TO_FIELD: Record<string, 'vehicle_positions' | 'trip_updates' | 'service_alerts'> = {
  vp: 'vehicle_positions',
  tu: 'trip_updates',
  sa: 'service_alerts',
};

export type Realtime = {
  vehicle_positions?: string;
  trip_updates?: string;
  service_alerts?: string;
};

type TransitousSource = {
  name?: string;
  type?: string;
  spec?: string;
  'mdb-id'?: string | number;
};

import { UA, fetchJson } from './http.js';

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

type GhTreeNode = { type?: string; path?: string };
type GhTreeResponse = { tree?: GhTreeNode[] };

let _treeCache: string[] | null = null;
async function getRtCatalogPaths(): Promise<string[]> {
  if (_treeCache) return _treeCache;
  // SKIP_ADAPTER_DRY_RUN=1 is the orchestrator's "zero external HTTP"
  // mode (PR-validation on forks without TRANZY_API_KEY). Returning an
  // empty list means RT resolution falls through to null — feeds
  // without explicit realtime config in feeds.json still work; feeds
  // that depend on MDB RT resolution just publish without the realtime
  // field, which is the safe failure mode.
  if (process.env.SKIP_ADAPTER_DRY_RUN === '1') {
    console.warn('[mdb-rt] SKIP_ADAPTER_DRY_RUN=1 — skipping MDB catalog fetch (no realtime resolution)');
    _treeCache = [];
    return _treeCache;
  }
  const tree = (await fetchJson(TREE_URL, ghHeaders())) as GhTreeResponse;
  _treeCache = (tree.tree ?? [])
    .filter((n) => n.type === 'blob'
      && typeof n.path === 'string'
      && n.path.startsWith('catalogs/sources/gtfs/realtime/')
      && n.path.endsWith('.json'))
    .map((n) => n.path as string);
  return _treeCache;
}

/**
 * Build a `realtime` object from a set of mdb-ids.
 */
export async function realtimeFromMdb(mdbIds: Array<string | number>): Promise<Realtime | null> {
  if (!mdbIds || mdbIds.length === 0) return null;
  const paths = await getRtCatalogPaths();

  const out: Realtime = {};
  for (const raw of mdbIds) {
    const id = String(raw).replace(/^mdb-/, '');
    const suffix = `-${id}.json`;
    const path = paths.find((p) => p.endsWith(suffix));
    if (!path) {
      console.warn(`[mdb-rt] no catalog file ending with ${suffix}`);
      continue;
    }
    const res = await fetch(`${RAW_BASE}/${path}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn(`[mdb-rt] fetch ${path}: HTTP ${res.status}`);
      continue;
    }
    const entry = await res.json() as { urls?: { direct_download?: string }; entity_type?: string[] };
    const url = entry.urls?.direct_download;
    const entityType = entry.entity_type?.[0];
    const field = entityType ? ENTITY_TYPE_TO_FIELD[entityType] : undefined;
    if (!url || !field) {
      console.warn(`[mdb-rt] ${path}: unusable (entity_type=${JSON.stringify(entry.entity_type)} url=${url ? 'yes' : 'no'})`);
      continue;
    }
    out[field] = url;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Convenience: from a Transitous `sources[]` array, find the RT siblings
 * matching `feedName` and resolve them.
 */
export async function resolveRealtimeForName(transitousSources: TransitousSource[], feedName: string): Promise<Realtime | null> {
  const rtSiblings = transitousSources.filter((s) =>
    s.name === feedName && s.spec === 'gtfs-rt'
    && s.type === 'mobility-database' && s['mdb-id']
  );
  if (rtSiblings.length === 0) return null;
  return realtimeFromMdb(rtSiblings.map((s) => s['mdb-id'] as string));
}