#!/usr/bin/env node
/**
 * compare-upstream-vs-pass-through.mjs
 *
 * Side-by-side comparison of two GTFS-RT VehiclePositions responses:
 *   <direct>   the upstream feed, fetched directly
 *   <via_rt>   the same feed, fetched via the local gtfs-rt container
 *
 * Decodes both as FeedMessage, builds a per-vehicle table with the
 * fields the cluj quirk operates on (trip_id, route_id, direction_id,
 * start_time) plus a position + timestamp for identification, then
 * prints a unified table and a diff (which fields differ between the
 * two responses for the same vehicle id).
 *
 * Usage:
 *   node compare-upstream-vs-pass-through.mjs <direct.pb> <via_rt.pb>
 *
 * Exits non-zero if the two responses are not materially identical
 * (i.e. if fields differ beyond the expected header.timestamp drift).
 */
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { readFileSync } from 'node:fs';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

function decode(p) {
  const buf = readFileSync(p);
  return FeedMessage.decode(buf);
}

function vehicleKey(v) {
  // Vehicle id is the natural key (operator-assigned). Falls back to
  // entity id. Trips that change direction_id between fetches still
  // share the same vehicle key, which is what we want for diffing.
  return v.vehicle?.vehicle?.id || v.entity?.id || '';
}

function vehicleFields(label, msg) {
  const hdr = msg.header ?? {};
  return {
    label,
    header: {
      gtfsRealtimeVersion: hdr.gtfsRealtimeVersion ?? '',
      incrementality: hdr.incrementality ?? '',
      timestamp: Number(hdr.timestamp ?? 0),
    },
    entityCount: msg.entity?.length ?? 0,
    vehicles: (msg.entity ?? []).map((e) => {
      const v = e.vehicle ?? {};
      const t = v.trip ?? {};
      const p = v.position ?? {};
      return {
        vehicleId: v.vehicle?.id || e.id || '',
        tripId: t.tripId || '',
        routeId: t.routeId || '',
        directionId: t.directionId ?? null,
        startTime: t.startTime || '',
        lat: p.latitude ?? null,
        lon: p.longitude ?? null,
        timestamp: Number(v.timestamp ?? 0),
      };
    }),
  };
}

function fmt(v, align = false) {
  if (v === null || v === undefined) return '_';
  const s = String(v);
  if (!align) return s;
  return s.padEnd(12);
}

function printTable(label, f) {
  console.log(`\n== ${label} ==`);
  console.log(`header: gtfsRealtimeVersion=${f.header.gtfsRealtimeVersion}, incrementality=${f.header.incrementality}, timestamp=${f.header.timestamp}`);
  console.log(`entity count: ${f.entityCount}`);
  console.log(
    [
      'vehicle_id  '.padEnd(12),
      'trip_id'.padEnd(20),
      'route'.padEnd(8),
      'dir'.padEnd(5),
      'start_time'.padEnd(11),
      'lat        '.padEnd(10),
      'lon       '.padEnd(11),
      'ts'.padEnd(11),
    ].join(' ')
  );
  for (const v of f.vehicles.slice(0, 30)) {
    console.log(
      [
        fmt(v.vehicleId, true),
        fmt(v.tripId).padEnd(20),
        fmt(v.routeId).padEnd(8),
        fmt(v.directionId).padEnd(5),
        fmt(v.startTime).padEnd(11),
        fmt(v.lat?.toFixed?.(4)).padEnd(10),
        fmt(v.lon?.toFixed?.(4)).padEnd(11),
        fmt(v.timestamp).padEnd(11),
      ].join(' ')
    );
  }
  if (f.vehicles.length > 30) console.log(`... (${f.vehicles.length - 30} more)`);
}

function diff(label, a, b) {
  const mapA = new Map(a.vehicles.map((v) => [v.vehicleId, v]));
  const mapB = new Map(b.vehicles.map((v) => [v.vehicleId, v]));
  const ids = new Set([...mapA.keys(), ...mapB.keys()]);
  const diffs = [];
  for (const id of ids) {
    const x = mapA.get(id);
    const y = mapB.get(id);
    if (!x) {
      diffs.push({ id, kind: 'only-in-b', values: { onlyIn: 'via_rt', vehicle: y } });
      continue;
    }
    if (!y) {
      diffs.push({ id, kind: 'only-in-a', values: { onlyIn: 'direct', vehicle: x } });
      continue;
    }
    const fieldDiffs = {};
    for (const k of ['tripId', 'routeId', 'directionId', 'startTime']) {
      if ((x[k] ?? null) !== (y[k] ?? null)) fieldDiffs[k] = { a: x[k], b: y[k] };
    }
    if (Object.keys(fieldDiffs).length > 0) {
      diffs.push({ id, kind: 'field-mismatch', values: fieldDiffs });
    }
  }
  console.log(`\n== diff: ${label} ==`);
  if (diffs.length === 0) {
    console.log('NO FIELD DIFFS (same vehicles, same trip/route/dir/start_time)');
    return 0;
  }
  for (const d of diffs.slice(0, 20)) {
    console.log(`vehicle ${d.id}: ${d.kind} ->`, JSON.stringify(d.values));
  }
  if (diffs.length > 20) console.log(`... (${diffs.length - 20} more diffs)`);
  return diffs.length;
}

const directPath = process.argv[2];
const viaRtPath = process.argv[3];
if (!directPath || !viaRtPath) {
  console.error('usage: compare-upstream-vs-pass-through.mjs <direct.pb> <via_rt.pb>');
  process.exit(2);
}

const directMsg = decode(directPath);
const viaRtMsg = decode(viaRtPath);

const directF = vehicleFields('direct', directMsg);
const viaRtF = vehicleFields('via_gtfs_rt', viaRtMsg);

printTable('direct', directF);
printTable('via_gtfs_rt', viaRtF);

const diffCount = diff('direct vs via_gtfs_rt', directF, viaRtF);

console.log(`\nheader.timestamp delta: direct=${directF.header.timestamp}, via_rt=${viaRtF.header.timestamp}, diff=${viaRtF.header.timestamp - directF.header.timestamp}s (expected: minutes, not zero — separate fetches)`);

process.exit(diffCount === 0 ? 0 : 1);
