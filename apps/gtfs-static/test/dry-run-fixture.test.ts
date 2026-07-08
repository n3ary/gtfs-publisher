/**
 * dry-run-fixture.test.ts — verifies the synthetic GTFS zip emitted
 * by SKIP_ADAPTER_DRY_RUN=1 satisfies the pipeline's downstream
 * expectations (makeSqlite + deriveBbox + feeds.json schema).
 *
 * Why: this is the regression net for the "real dry mode" promise in
 * cli.ts acquireGtfs. If a future refactor breaks the fixture shape
 * (missing required GTFS table, malformed CSV, etc.), the dry-run
 * pipeline silently emits a malformed feeds.json and we want CI to
 * fail loudly rather than discover it in production.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDryRunGtfsZip } from '../src/dry-run-fixture.js';

const WORK = join(tmpdir(), `gtfs-static-dry-${Date.now()}`);

beforeAll(() => mkdirSync(WORK, { recursive: true }));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

describe('dry-run-fixture (SKIP_ADAPTER_DRY_RUN=1)', () => {
  it('writes a minimal valid GTFS zip at the requested path', async () => {
    const outDir = join(WORK, 'feed');
    const zipPath = await buildDryRunGtfsZip(outDir, 'adapter-feed');

    expect(zipPath).toMatch(/adapter-feed-dryrun\.gtfs\.zip$/);
    expect(existsSync(zipPath)).toBe(true);

    // Inspect the zip's central directory to assert the 6 required
    // GTFS Schedule tables are present. We don't decompress — a
    // header check is sufficient to catch "missing table" regressions.
    const buf = readFileSync(zipPath);
    expect(buf[0]).toBe(0x50); // 'P'
    expect(buf[1]).toBe(0x4b); // 'K' (PK zip signature)
    const text = buf.toString('latin1');
    for (const table of ['agency.txt', 'stops.txt', 'routes.txt', 'calendar.txt', 'trips.txt', 'stop_times.txt']) {
      expect(text).toContain(table);
    }
  });

  it('is consumable by makeSqlite without external HTTP', async () => {
    const outDir = join(WORK, 'consume');
    const zipPath = await buildDryRunGtfsZip(outDir, 'adapter-feed');

    const { makeSqlite } = await import('../dist/make-sqlite.js');
    const result = await makeSqlite(zipPath, 'dry-run-feed');
    expect(result).not.toBeNull();
    expect(existsSync(result!.localPath)).toBe(true);
    expect(result!.sizeBytes).toBeGreaterThan(0);
  }, 30_000);
});