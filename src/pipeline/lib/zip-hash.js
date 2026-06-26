/**
 * zip-hash.js — stable content hash of a GTFS .zip.
 *
 * Hashes the SORTED list of entry-name + entry-content pairs, not the
 * zip wrapper bytes. Two zips with identical contents but different
 * timestamps / compression metadata produce the same hash. This is the
 * change-detection primitive for locally-built feeds (mirrors use
 * upstream ETag instead — see build-all.js).
 *
 * Tradeoff: we re-read every entry via `unzip -p`, which is ~500 ms for
 * cluj-napoca's 14k-trip zip on a typical CI runner. Cheap compared to
 * the ~30s make-sqlite + 5 MB publish it lets us skip.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function listEntries(zipPath) {
  const r = spawnSync('unzip', ['-Z1', zipPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`unzip -Z1 ${zipPath} failed (status ${r.status})`);
  return r.stdout.split('\n').filter((l) => l.length > 0 && !l.endsWith('/'));
}

function readEntryBytes(zipPath, entryName) {
  const r = spawnSync('unzip', ['-p', zipPath, entryName], {
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.status !== 0 && r.status !== null) throw new Error(`unzip -p ${entryName} failed`);
  return r.stdout;
}

/**
 * @param {string} zipPath
 * @returns {string} sha256 hex prefixed with "sha256-"
 */
export function stableZipContentHash(zipPath) {
  const entries = listEntries(zipPath).sort();
  const h = createHash('sha256');
  for (const name of entries) {
    h.update(name);
    h.update('\0');
    h.update(readEntryBytes(zipPath, name));
    h.update('\0');
  }
  return 'sha256-' + h.digest('hex');
}
