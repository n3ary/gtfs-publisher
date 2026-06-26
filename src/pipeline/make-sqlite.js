/**
 * make-sqlite.js — STUB (M2).
 *
 * In M1 we publish feeds.json with `files.sqlite_gz = null` for every
 * feed. The v2 app continues to consume its dev-data SQLite locally
 * during M1 testing.
 *
 * M2 brings this online by porting the logic from
 * `apps/web/scripts/build-sqlite` (in the main neary repo) into this
 * file. The port converts a GTFS .zip into a populated SQLite blob
 * with the same schema the app's worker expects, then gzips it.
 *
 * Until then, this function is a no-op that returns `null` so
 * make-app-registry.js writes the right shape in feeds.json.
 *
 * @param {string} _gtfsZipPath
 * @returns {Promise<{ localPath: string, sizeBytes: number } | null>}
 */
export async function makeSqlite(_gtfsZipPath) {
  return null;
}
