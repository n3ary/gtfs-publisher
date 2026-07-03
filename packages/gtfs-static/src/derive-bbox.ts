/**
 * derive-bbox.ts — read a few .txt entries from a GTFS .zip and return:
 *   - bbox: { minLat, minLon, maxLat, maxLon }
 *   - center: bbox midpoint
 *   - agencies: parsed from agency.txt
 *   - timezone: from agency.txt (first non-empty agency_timezone)
 *   - validity: { from, until } parsed from feed_info.txt (nullable)
 *
 * Uses the system `unzip` binary — present on every Linux CI runner +
 * macOS, avoids pulling a zip-reader dep just to read 3 small files.
 */

import { spawnSync } from 'node:child_process';

import { parseCsv } from './lib/csv.js';
import type { DerivedMeta } from './lib/types.js';

function readEntry(zipPath: string, entryName: string): string | null {
  const res = spawnSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // Optional entries (feed_info.txt) — return null so caller can skip.
  if (res.status !== 0 && res.status !== null) return null;
  return res.stdout || null;
}

export function deriveBbox(zipPath: string): DerivedMeta {
  // ---- stops.txt → bbox ----
  const stopsCsv = readEntry(zipPath, 'stops.txt');
  if (!stopsCsv) throw new Error(`${zipPath}: stops.txt missing`);
  const stops = parseCsv(stopsCsv);

  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let n = 0;
  for (const s of stops) {
    const lat = parseFloat(s.stop_lat ?? '');
    const lon = parseFloat(s.stop_lon ?? '');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat === 0 && lon === 0) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    n++;
  }
  if (n === 0) throw new Error(`${zipPath}: no stops with valid coordinates`);

  // round to 5 decimals (~1 m precision) — keeps feeds.json tidy
  const round = (x: number) => Math.round(x * 1e5) / 1e5;
  const bbox = {
    minLat: round(minLat),
    minLon: round(minLon),
    maxLat: round(maxLat),
    maxLon: round(maxLon),
  };
  const center = {
    lat: round((minLat + maxLat) / 2),
    lon: round((minLon + maxLon) / 2),
  };

  // ---- agency.txt → agencies[] + timezone ----
  const agencyCsv = readEntry(zipPath, 'agency.txt');
  const agencyRows = agencyCsv ? parseCsv(agencyCsv) : [];
  const agencies = agencyRows
    .filter((a) => a.agency_name && a.agency_name.trim() !== '')
    .map((a) => ({
      agency_id: a.agency_id || null,
      agency_name: a.agency_name!,
      agency_url: a.agency_url || null,
    }));
  const timezone = agencyRows.find((a) => a.agency_timezone)?.agency_timezone ?? null;

  // ---- feed_info.txt → validity / timezone (optional) ----
  const feedInfoCsv = readEntry(zipPath, 'feed_info.txt');
  let validity: DerivedMeta['validity'] = { from: null, until: null };
  if (feedInfoCsv) {
    const rows = parseCsv(feedInfoCsv);
    if (rows.length > 0) {
      const r = rows[0]!;
      const fmt = (gtfsDate: string | undefined) => {
        if (!gtfsDate || gtfsDate.length !== 8) return null;
        return `${gtfsDate.slice(0, 4)}-${gtfsDate.slice(4, 6)}-${gtfsDate.slice(6, 8)}`;
      };
      validity = { from: fmt(r.feed_start_date), until: fmt(r.feed_end_date) };
    }
  }

  return { bbox, center, agencies, timezone, validity };
}