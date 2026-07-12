/**
 * Tests for the generic `read-csv-from-zip` helper. The orchestrator
 * uses this to parse producer-extension files declared by the
 * adapter's `producerExtensions` manifest — these tests pin the
 * feed-agnostic behavior (header-driven columns, opaque rows, all
 * values as strings).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, createWriteStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipArchive } from 'archiver';
import { parseCsv, readCsvFromZip } from '../src/lib/read-csv-from-zip.js';

let WORK: string;
let ZIP_PATH: string;
let MISSING_PATH: string;
let PROBE_FILE: string;

beforeAll(async () => {
  WORK = mkdtempSync(join(tmpdir(), 'gtfs-static-readcsv-'));
  ZIP_PATH = join(WORK, 'with-csv.gtfs.zip');
  MISSING_PATH = join(WORK, 'does-not-exist.gtfs.zip');
  // Generic test artifact: a producer-extension file with a
  // deliberately feed-neutral name. The helper must treat the
  // contents as opaque (`Record<string, string>`) — the column
  // names here are just to exercise the parser, not to mirror
  // any specific adapter's schema.
  PROBE_FILE = 'producer_ext.txt';

  const out = createWriteStream(ZIP_PATH);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  await new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(out);
    archive.append(
      [
        'id,kind,label,weight',
        '1,school,Transport Elevi,1',
        '2,metroline,Metropolitan,5',
        '3,festival,Untold,2',
        '',
      ].join('\n'),
      { name: PROBE_FILE },
    );
    archive.finalize();
  });
});

afterAll(() => {
  if (existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
});

describe('parseCsv (pure parser)', () => {
  it('parses a header + rows into keyed records', () => {
    const text = [
      'id,kind,weight',
      '1,school,1',
      '2,metroline,5',
    ].join('\n');
    expect(parseCsv(text)).toEqual([
      { id: '1', kind: 'school', weight: '1' },
      { id: '2', kind: 'metroline', weight: '5' },
    ]);
  });

  it('skips empty / blank lines', () => {
    const text = [
      'a,b',
      '1,2',
      '',
      '3,4',
      '   ',
      '5,6',
    ].join('\n');
    expect(parseCsv(text)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
      { a: '5', b: '6' },
    ]);
  });

  it('trims whitespace from each value', () => {
    const text = 'a, b , c\n  1  ,  2  ,  3  ';
    expect(parseCsv(text)).toEqual([{ a: '1', b: '2', c: '3' }]);
  });

  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('handles quoted commas (csv-parse dialect)', () => {
    // The producer side uses csv-stringify, which quotes values
    // containing commas. The publisher's parser must round-trip
    // that — naive split(',') would corrupt the row.
    const text = [
      'name,desc',
      '"a, b","hello, world"',
    ].join('\n');
    expect(parseCsv(text)).toEqual([
      { name: 'a, b', desc: 'hello, world' },
    ]);
  });

  it('returns all values as strings (no number coercion)', () => {
    // The orchestrator does not interpret types — adapters own
    // coercion. Verify: numeric-looking values come back as
    // strings, even ones that look like decimals.
    const text = 'n,m\n42,3.14';
    expect(parseCsv(text)).toEqual([{ n: '42', m: '3.14' }]);
  });
});

describe('readCsvFromZip (zip I/O)', () => {
  it('reads a CSV file from a zip by exact name', async () => {
    const rows = await readCsvFromZip(ZIP_PATH, PROBE_FILE);
    expect(rows).toEqual([
      { id: '1', kind: 'school', label: 'Transport Elevi', weight: '1' },
      { id: '2', kind: 'metroline', label: 'Metropolitan', weight: '5' },
      { id: '3', kind: 'festival', label: 'Untold', weight: '2' },
    ]);
  });

  it('returns [] when the file is absent (graceful degradation)', async () => {
    // Old zips (pre-producer-extension declarations) and feeds
    // whose adapter doesn't declare this file should not crash
    // the build — the helper returns [].
    const rows = await readCsvFromZip(ZIP_PATH, 'does_not_exist.txt');
    expect(rows).toEqual([]);
  });

  it('rejects when the zip itself is missing (throws clearly)', async () => {
    // An absent zip is a different failure mode than an absent
    // file. The pipeline guards on `gtfs.localPath &&
    // existsSync(gtfs.localPath)` before walking
    // `producerExtensions`, so this case never reaches the helper
    // in production. We document the current behavior here:
    // StreamZip.async throws a clear error (we don't swallow it).
    await expect(readCsvFromZip(MISSING_PATH, PROBE_FILE)).rejects.toThrow();
  });

  it('closes the zip even when the entry is missing', async () => {
    // Regression guard: the helper opens a StreamZip.async and
    // must always close it in a `finally`. Calling it twice in
    // a row exercises the close path. If the close were missing,
    // the second call would hang or error with a "file already
    // open" diagnostic.
    const a = await readCsvFromZip(ZIP_PATH, 'nope.txt');
    const b = await readCsvFromZip(ZIP_PATH, PROBE_FILE);
    expect(a).toEqual([]);
    expect(b.length).toBe(3);
  });
});
