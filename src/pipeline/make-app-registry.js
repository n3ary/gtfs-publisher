/**
 * make-app-registry.js — emit outputs/feeds.json (the app-facing index).
 *
 * Validates against schemas/feeds.schema.json using Ajv's draft-2020 mode
 * so a malformed registry fails the build before publish.
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

/**
 * @param {Array<object>} feedEntries - one per resolved feed, shape:
 *   {
 *     feed: <from resolve-feeds, possibly merged with deriveBbox fields>,
 *     gtfs: { localPath, sizeBytes, hash },
 *     sqlite: { localPath, sizeBytes } | null,
 *     bbox, center, agencies, validity,
 *   }
 */
export function makeAppRegistry(feedEntries) {
  const generatedAt = new Date().toISOString();

  const registry = {
    version: generatedAt,
    generated_at: generatedAt,
    feeds: feedEntries.map((e) => {
      const f = e.feed;
      // Prefer agencies parsed from the actual GTFS agency.txt over what
      // resolve-feeds optimistically populated.
      const agencies = e.agencies && e.agencies.length > 0 ? e.agencies : f.agencies;
      return {
        id: f.id,
        name: f.name,
        country: f.country,
        ...(f.region != null ? { region: f.region } : {}),
        timezone: f.timezone ?? e.timezone ?? 'UTC',
        ...(f.languages && f.languages.length ? { languages: f.languages } : {}),
        bbox: e.bbox,
        center: e.center,
        agencies,
        source: f.source,
        files: {
          gtfs_zip: `feeds/${f.id}.gtfs.zip`,
          sqlite_gz: e.sqlite ? `feeds/${f.id}.sqlite3.gz` : null,
        },
        size_bytes: {
          gtfs_zip: e.gtfs.sizeBytes,
          sqlite_gz: e.sqlite ? e.sqlite.sizeBytes : null,
        },
        hash: e.gtfs.hash,
        generated_at: generatedAt,
        valid_from: e.validity?.from ?? null,
        valid_until: e.validity?.until ?? null,
        ...(f.realtime ? { realtime: f.realtime } : { realtime: null }),
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
