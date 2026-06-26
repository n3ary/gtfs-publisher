/**
 * derive-bbox.js — read stops.txt from a GTFS .zip and return:
 *   - bbox: { minLat, minLon, maxLat, maxLon }
 *   - center: bbox midpoint
 *   - agencies: array parsed from agency.txt
 *   - validity: { from, until } parsed from feed_info.txt (nullable)
 *
 * Uses the system `unzip` binary (present on every Linux CI runner and
 * macOS) to avoid pulling a zip-reader dependency. The data we need is
 * tiny so streaming a few `unzip -p` calls is faster than parsing the
 * full archive in JS.
 */

import { spawnSync } from 'node:child_process';

function readEntry(zipPath, entryName) {
  const res = spawnSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0 && res.status !== null) {
    // Some entries (feed_info.txt) are optional; surface as null.
    return null;
  }
  return res.stdout || null;
}

/**
 * Tiny CSV parser sufficient for GTFS plain-comma files. Does NOT handle
 * embedded quoted commas if any field both has commas AND quotes; GTFS
 * stops.txt / agency.txt almost never do, but if needed we can swap in a
 * full RFC 4180 parser later.
 */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseLine(line);
    const row = {};
    header.forEach((key, i) => { row[key] = cols[i] ?? ''; });
    return row;
  });
}

function parseLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

export function deriveBbox(zipPath) {
  // ---- stops.txt → bbox ----
  const stopsCsv = readEntry(zipPath, 'stops.txt');
  if (!stopsCsv) throw new Error(`${zipPath}: stops.txt missing`);
  const stops = parseCsv(stopsCsv);

  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  let n = 0;
  for (const s of stops) {
    const lat = parseFloat(s.stop_lat);
    const lon = parseFloat(s.stop_lon);
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
  const round = (x) => Math.round(x * 1e5) / 1e5;
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

  // ---- agency.txt → agencies[] ----
  const agencyCsv = readEntry(zipPath, 'agency.txt');
  const agencies = agencyCsv
    ? parseCsv(agencyCsv).map((a) => ({
        agency_id: a.agency_id || null,
        agency_name: a.agency_name,
        agency_url: a.agency_url || null,
      }))
    : [];

  // ---- feed_info.txt → validity / timezone (optional) ----
  const feedInfoCsv = readEntry(zipPath, 'feed_info.txt');
  let validity = { from: null, until: null };
  if (feedInfoCsv) {
    const rows = parseCsv(feedInfoCsv);
    if (rows.length > 0) {
      const r = rows[0];
      const fmt = (gtfsDate) => {
        if (!gtfsDate || gtfsDate.length !== 8) return null;
        return `${gtfsDate.slice(0, 4)}-${gtfsDate.slice(4, 6)}-${gtfsDate.slice(6, 8)}`;
      };
      validity = { from: fmt(r.feed_start_date), until: fmt(r.feed_end_date) };
    }
  }

  return { bbox, center, agencies, validity };
}
