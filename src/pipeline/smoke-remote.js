/**
 * smoke-remote.js — post-fetch contract check for source.type='remote' feeds.
 *
 * Verifies the upstream zip honors what the consumer relies on:
 *   1. feed_info.txt.feed_publisher_name matches `expectedPublisher`
 *      (catches an accidental override / repo rename / wrong URL).
 *   2. Every trips.txt trip_id matches `tripIdPattern` (the contract the
 *      neary reconciler's parseLiveStartMin fallback depends on — see
 *      docs/issues/neary-gtfs-remote-source.md in the adapter repo).
 *
 * Per-feed expectations live in feeds/<id>/config.json `smoke` block.
 * If no expectations are declared, this is a no-op.
 *
 * Throws on contract violation so the build fails before publish.
 */

import { spawnSync } from 'node:child_process';

import { parseCsv } from './lib/csv.js';

function readEntry(zipPath, entryName) {
  const r = spawnSync('unzip', ['-p', zipPath, entryName], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== null) return null;
  return r.stdout || null;
}

/**
 * @param {string} zipPath
 * @param {{ expectedPublisher?: string, tripIdPattern?: string } | null | undefined} smoke
 * @returns {{ checks: string[] }} list of checks actually run (for logging)
 * @throws Error on first contract violation
 */
export function smokeTestRemote(zipPath, smoke) {
  if (!smoke) return { checks: [] };
  const checks = [];

  if (smoke.expectedPublisher) {
    const csv = readEntry(zipPath, 'feed_info.txt');
    if (!csv) throw new Error(`smoke: feed_info.txt missing (expected publisher "${smoke.expectedPublisher}")`);
    const rows = parseCsv(csv);
    const actual = rows[0]?.feed_publisher_name;
    if (actual !== smoke.expectedPublisher) {
      throw new Error(`smoke: feed_publisher_name mismatch — expected "${smoke.expectedPublisher}", got "${actual ?? '(missing)'}"`);
    }
    checks.push(`feed_publisher_name="${actual}"`);
  }

  if (smoke.tripIdPattern) {
    const re = new RegExp(smoke.tripIdPattern);
    const csv = readEntry(zipPath, 'trips.txt');
    if (!csv) throw new Error('smoke: trips.txt missing');
    const rows = parseCsv(csv);
    const bad = [];
    for (const t of rows) {
      if (!re.test(t.trip_id)) {
        bad.push(t.trip_id);
        if (bad.length >= 5) break;
      }
    }
    if (bad.length > 0) {
      throw new Error(`smoke: ${bad.length}+ trip_id(s) violate pattern ${smoke.tripIdPattern} (e.g. ${bad.join(', ')})`);
    }
    checks.push(`trip_id matches ${smoke.tripIdPattern} (n=${rows.length})`);
  }

  return { checks };
}
