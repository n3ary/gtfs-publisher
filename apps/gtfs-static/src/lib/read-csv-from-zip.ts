/**
 * lib/read-csv-from-zip.ts — generic CSV reader for producer-extension
 * files inside a GTFS zip.
 *
 * The orchestrator (`@gtfs/static`) is feed-agnostic. Per-feed
 * knowledge lives in the adapter's `/static` module, which exports
 * a `producerExtensions` manifest:
 *
 *   export const producerExtensions = [
 *     { fileName: '<file>.txt', feedConfigKey: '<feedConfigKey>' },
 *   ];
 *
 * The orchestrator walks that list, calls this helper for each
 * entry, and populates `feedConfig[feedConfigKey]` with the parsed
 * rows. The orchestrator does NOT interpret the rows — it just hands
 * the strings to the adapter, which is responsible for type
 * coercion (e.g. `priority: '3'` -> 3) when it writes to SQLite.
 *
 * Spec parsers live with `@n3ary/gtfs-spec`; producer-extension
 * parsers live with the publisher. This helper is the only place in
 * the publisher that knows how to read a CSV out of a zip — the
 * adapter side just declares what to read.
 */

import StreamZip from 'node-stream-zip';
import { parse } from 'csv-parse/sync';

/** Cap the read at 16 MiB. A typical producer extension is a few
 * KiB. 16 MiB is several orders of magnitude headroom for a future
 * feed with many more tagged routes; it's also small enough that a
 * pathological zip can't OOM the orchestrator. */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * Read a CSV file from a GTFS zip and return the parsed rows.
 *
 * Returns `[]` (not throws) when the file is absent — graceful
 * degradation is the right call for producer extensions that may
 * not be present in every zip build (e.g. older adapter versions).
 * Throws only on a malformed CSV or a runaway file size.
 *
 * @param {string} zipPath    absolute path to the staged .gtfs.zip
 * @param {string} fileName   file name inside the zip
 *                            (e.g. `<file>.txt`)
 * @returns {Promise<Record<string, string>[]>}  one entry per data row,
 *                              keyed by header column. All values are
 *                              strings — type coercion is the adapter's
 *                              responsibility (see the adapter's
 *                              `staticExtension()`).
 */
export async function readCsvFromZip(
  zipPath: string,
  fileName: string,
): Promise<Record<string, string>[]> {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entry = await zip.entry(fileName);
    if (!entry) return [];
    if (entry.size > MAX_BYTES) {
      throw new Error(
        `${fileName} is ${entry.size} bytes; refusing to read (>${MAX_BYTES}). ` +
        'Investigate the producer — a single file this size suggests a runaway emission.',
      );
    }
    const buf = await zip.entryData(entry) as Buffer;
    return parseCsv(buf.toString('utf8'));
  } finally {
    await zip.close();
  }
}

/**
 * Parse a CSV body. Pure function (no I/O) so it's trivially
 * unit-testable. The first row is the header; each subsequent row
 * becomes a `Record<header, value>`. Empty / blank lines are
 * skipped. Values are returned as strings — type coercion is the
 * caller's responsibility.
 *
 * Uses `csv-parse/sync` so quoted commas, embedded newlines, and
 * escaped quotes inside cells all round-trip correctly (the
 * producer side typically writes via `csv-stringify`, which
 * produces the same dialect).
 *
 * @param {string} text  the full CSV body (header + rows + trailing newline)
 * @returns {Record<string, string>[]}
 */
export function parseCsv(text: string): Record<string, string>[] {
  if (!text) return [];
  return parse(text, {
    columns: true,            // first row is header; return objects
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}
