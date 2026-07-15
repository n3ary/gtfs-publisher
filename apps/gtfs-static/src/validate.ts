/**
 * validate.ts — light spec-shape validator for GTFS .zips we publish.
 *
 * Runs on `source.type === 'remote'` feeds (the externally-built zips
 * we pull from upstream URLs we don't control). Transitous mirrors and
 * adapter-driven feeds are trusted to upstream / adapter validation.
 *
 * Catches the bug classes an upstream build is realistically capable of
 * introducing:
 *
 *   - missing required file
 *   - missing required column in a header
 *   - empty essential table (trips / stop_times / calendar)
 *   - cross-reference orphans:
 *       trips.service_id  not in calendar.service_id
 *       trips.route_id    not in routes.route_id
 *       stop_times.trip_id not in trips.trip_id
 *       stop_times.stop_id not in stops.stop_id
 *   - non-monotonic stop_sequence within a trip
 *
 * Does NOT catch subtle issues the canonical validator does (timezone
 * format quirks, fare/transfer/pathway consistency, etc.).
 */

import { spawnSync } from 'node:child_process';

import { parseCsv, type CsvRow } from './lib/csv.js';

const REQUIRED_FILES = ['agency.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'calendar.txt'];
const REQUIRED_COLUMNS: Record<string, string[]> = {
  'agency.txt':     ['agency_name', 'agency_url', 'agency_timezone'],
  'routes.txt':     ['route_id', 'route_type'],
  'stops.txt':      ['stop_id', 'stop_lat', 'stop_lon'],
  'trips.txt':      ['route_id', 'service_id', 'trip_id'],
  'stop_times.txt': ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
  'calendar.txt':   ['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'],
};

function readEntry(zipPath: string, entryName: string): string | null {
  const res = spawnSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024, // up to 1 GB — stop_times can be huge
  });
  if (res.status !== 0 && res.status !== null) return null;
  return res.stdout || null;
}

/**
 * @throws Error on first validation failure (with a list of all errors)
 */
export function validate(zipPath: string): { warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const E = (m: string) => errors.push(m);
  const W = (m: string) => warnings.push(m);

  // ---- required files + columns ----
  const tables: Record<string, CsvRow[]> = {};
  for (const f of REQUIRED_FILES) {
    const text = readEntry(zipPath, f);
    if (text === null) { E(`missing required file: ${f}`); continue; }
    const rows = parseCsv(text);
    const header = rows.length > 0 ? Object.keys(rows[0]!) : (text.split('\n')[0] ?? '').split(',');
    tables[f] = rows;
    for (const col of REQUIRED_COLUMNS[f]!) {
      if (!header.includes(col)) E(`${f}: missing required column "${col}"`);
    }
    if (REQUIRED_FILES.includes(f) && rows.length === 0) {
      // calendar.txt with no rows is allowed if calendar_dates.txt covers all
      // services; calendar_dates.txt with no rows is allowed if calendar.txt covers
      // all services. Either one being empty alone is fine; we don't error on that.
      if (f !== 'agency.txt' && f !== 'calendar.txt' && f !== 'calendar_dates.txt') {
        E(`${f}: 0 rows (essential table empty)`);
      }
    }
  }
  if (errors.length > 0) throwReport(zipPath, errors, warnings);

  // ---- calendar_dates.txt: optional per GTFS spec (calendar OR calendar_dates
  //     defines services) — load only if present and validate its columns ----
  const calDatesText = readEntry(zipPath, 'calendar_dates.txt');
  if (calDatesText !== null) {
    const calDatesRows = parseCsv(calDatesText);
    const calDatesHeader = calDatesRows.length > 0
      ? Object.keys(calDatesRows[0]!)
      : calDatesText.split('\n')[0]!.split(',');
    for (const col of ['service_id', 'date', 'exception_type']) {
      if (!calDatesHeader.includes(col)) E(`calendar_dates.txt: missing required column "${col}"`);
    }
    tables['calendar_dates.txt'] = calDatesRows;
  }

  if (errors.length > 0) throwReport(zipPath, errors, warnings);

  // ---- cross-reference checks ----
  const routeIds = new Set((tables['routes.txt'] ?? []).map((r) => r.route_id));
  const stopIds = new Set((tables['stops.txt'] ?? []).map((s) => s.stop_id));
  // A service_id can be defined in either calendar.txt or calendar_dates.txt.
  // GTFS spec: "If the service_id appears in either file, it is valid."
  const calendarSids = new Set((tables['calendar.txt'] ?? []).map((c) => c.service_id));
  const calDatesSids = new Set((tables['calendar_dates.txt'] ?? []).map((c) => c.service_id));
  const serviceIds = new Set([...calendarSids, ...calDatesSids]);
  const tripIds = new Set<string>();

  // Sample-based cross-checks: counting all orphans makes the message huge;
  // ERROR if ANY exist, but cap reported examples to 5.
  const orphan = (label: string, count: number, sample: string[]) =>
    `${label}: ${count} orphan${count === 1 ? '' : 's'} (e.g. ${sample.slice(0, 5).join(', ')})`;

  const tripOrphansRoute: string[] = [];
  const tripOrphansService: string[] = [];
  for (const t of tables['trips.txt'] ?? []) {
    if (t.trip_id) tripIds.add(t.trip_id);
    if (!routeIds.has(t.route_id ?? '')) tripOrphansRoute.push(`${t.trip_id}→route_id ${t.route_id}`);
    if (!serviceIds.has(t.service_id ?? '')) tripOrphansService.push(`${t.trip_id}→service_id ${t.service_id}`);
  }
  if (tripOrphansRoute.length > 0)   E(orphan('trips.route_id', tripOrphansRoute.length, tripOrphansRoute));
  if (tripOrphansService.length > 0) E(orphan('trips.service_id', tripOrphansService.length, tripOrphansService));

  const stOrphansTrip: string[] = [];
  const stOrphansStop: string[] = [];
  const seqByTrip = new Map<string, number>(); // trip_id → last seen stop_sequence
  for (const st of tables['stop_times.txt'] ?? []) {
    if (!tripIds.has(st.trip_id ?? '')) stOrphansTrip.push(st.trip_id ?? '');
    if (!stopIds.has(st.stop_id ?? '')) stOrphansStop.push(`${st.trip_id}→stop_id ${st.stop_id}`);
    const seq = parseInt(st.stop_sequence ?? '', 10);
    const last = seqByTrip.get(st.trip_id ?? '');
    if (last !== undefined && seq <= last) {
      E(`stop_times: non-monotonic stop_sequence for trip ${st.trip_id} (${last} → ${seq})`);
      break; // one example is enough
    }
    seqByTrip.set(st.trip_id ?? '', seq);
  }
  if (stOrphansTrip.length > 0) E(orphan('stop_times.trip_id', stOrphansTrip.length, stOrphansTrip));
  if (stOrphansStop.length > 0) E(orphan('stop_times.stop_id', stOrphansStop.length, stOrphansStop));

  // ---- stat warnings ----
  const tripsWithoutST = [...tripIds].filter((id) => !seqByTrip.has(id));
  if (tripsWithoutST.length > 0) W(`${tripsWithoutST.length} trips have no stop_times entries`);

  if (errors.length > 0) throwReport(zipPath, errors, warnings);

  return { warnings };
}

function throwReport(zipPath: string, errors: string[], warnings: string[]): never {
  const lines = [`[validate] ${zipPath}: ${errors.length} error(s), ${warnings.length} warning(s)`];
  for (const e of errors)  lines.push(`  ERROR   ${e}`);
  for (const w of warnings) lines.push(`  WARN    ${w}`);
  throw new Error(lines.join('\n'));
}