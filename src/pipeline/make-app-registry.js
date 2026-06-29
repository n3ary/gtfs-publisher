/**
 * make-app-registry.js — emit outputs/feeds.json (the app-facing index).
 *
 * Validates against schemas/feeds.schema.json using Ajv's draft-2020 mode
 * so a malformed registry fails the build before publish.
 *
 * Per-entry shape:
 *   - fresh entries: { feed, gtfs, sqlite, bbox, center, agencies, timezone,
 *                      validity, upstreamEtag }
 *   - reused entries: { reused: true, prevEntry: <previous feeds.json entry> }
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUTS = join(ROOT, 'outputs');
const SCHEMA_PATH = join(ROOT, 'schemas', 'feeds.schema.json');

export function makeAppRegistry(feedEntries) {
  const generatedAt = new Date().toISOString();

  const registry = {
    version: generatedAt,
    generated_at: generatedAt,
    feeds: feedEntries.map((e) => {
      // Reuse path: pass the previous entry through untouched. Its
      // `generated_at` reflects when the underlying data was actually
      // produced, not when we re-verified, which is the more useful
      // value for downstream freshness checks.
      if (e.reused) return e.prevEntry;

      const f = e.feed;
      return {
        id: f.id,
        name: f.name,
        country: f.country,
        ...(f.region != null ? { region: f.region } : {}),
        timezone: f.timezone ?? e.timezone ?? 'UTC',
        ...(f.languages?.length ? { languages: f.languages } : {}),
        bbox: e.bbox,
        center: e.center,
        agencies: e.agencies,
        source: {
          ...f.source,
          ...(e.upstreamEtag ? { upstream_etag: e.upstreamEtag } : {}),
        },
        files: {
          sqlite_gz: e.sqlite ? `${f.id}.sqlite3.gz` : null,
        },
        size_bytes: {
          sqlite_gz: e.sqlite ? e.sqlite.sizeBytes : null,
        },
        hash: e.sqlite?.hash ?? null,
        generated_at: generatedAt,
        valid_from: e.validity?.from ?? null,
        valid_until: e.validity?.until ?? null,
        realtime: f.realtime ?? null,
        ...(f.tranzy ? { tranzy: f.tranzy } : {}),
        license: f.license,
      };
    }),
  };

  // Validate
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(registry)) {
    console.error('[make-app-registry] feeds.json failed schema validation:');
    for (const e of validate.errors ?? []) {
      console.error(`  ${e.instancePath || '/'} ${e.message}`);
    }
    throw new Error('feeds.json failed schema validation');
  }

  mkdirSync(OUTPUTS, { recursive: true });
  const outPath = join(OUTPUTS, 'feeds.json');
  writeFileSync(outPath, JSON.stringify(registry, null, 2) + '\n');
  console.log(`[make-app-registry] wrote ${outPath} with ${registry.feeds.length} feed(s).`);
  return registry;
}
