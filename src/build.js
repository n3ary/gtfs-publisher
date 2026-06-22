#!/usr/bin/env node

/**
 * neary-gtfs build script
 *
 * Usage: node src/build.js --agency <agency_id>
 *
 * 1. Reads the agency config + route/stop registry from agencies/<id>/
 * 2. Downloads PDFs for all registered routes
 * 3. Parses departure times from PDFs
 * 4. Generates GTFS files (agency.txt, routes.txt, stops.txt, trips.txt,
 *    stop_times.txt, calendar.txt)
 * 5. Packages into a ZIP
 * 6. Compares content hash with the latest release
 * 7. Writes a CHANGED marker file if data differs (consumed by the GH Action)
 *
 * TODO: This is the scaffold. Implementation follows in subsequent tasks.
 */

import { parseArgs } from 'node:util';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Parse CLI args
const { values } = parseArgs({
  options: {
    agency: { type: 'string', short: 'a' },
  },
});

const agencyId = values.agency;
if (!agencyId) {
  console.error('Usage: node src/build.js --agency <agency_id>');
  process.exit(1);
}

// Load agency config
const agencyDir = join(ROOT, 'agencies', agencyId);
if (!existsSync(agencyDir)) {
  console.error(`Agency directory not found: ${agencyDir}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(agencyDir, 'config.json'), 'utf8'));
const routes = JSON.parse(readFileSync(join(agencyDir, 'routes.json'), 'utf8'));
const stops = JSON.parse(readFileSync(join(agencyDir, 'stops.json'), 'utf8'));

console.log(`[neary-gtfs] Building GTFS for agency ${agencyId}: ${config.name}`);
console.log(`[neary-gtfs] Routes registered: ${routes.routes.length}`);
console.log(`[neary-gtfs] Stops registered: ${stops.stops.length}`);

// Output directory
const outputDir = join(ROOT, 'output', `agency-${agencyId}`);
mkdirSync(outputDir, { recursive: true });

// TODO: Implement the pipeline steps:
// 1. fetchPdfs(config, routes)
// 2. parseSchedules(pdfs, routes, stops)
// 3. generateGtfs(schedules, config, routes, stops)
// 4. packageZip(outputDir)
// 5. compareWithLatestRelease(outputDir)

console.log(`[neary-gtfs] Pipeline scaffold complete. Implementation pending.`);
console.log(`[neary-gtfs] Output directory: ${outputDir}`);

// For now, write a marker so the action knows there's nothing to publish yet
writeFileSync(join(outputDir, 'BUILD_LOG.txt'), `Build at ${new Date().toISOString()}\nStatus: scaffold only\n`);
