/**
 * feeds.test.ts — end-to-end test of feeds.json loading against
 * the shared @n3ary/gtfs-spec schema.
 *
 * The interesting thing this catches: the FeedSchema lives in the
 * spec package, not here. A typo in the spec import, a bbox shape
 * drift (object vs tuple), or a missing field would all surface
 * here with a real fixtures.json sample.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeedsRegistrySchema, type FeedsRegistry } from "@n3ary/gtfs-spec/schema";
import { fetchFeedsRegistry, filterEnabled } from "./feeds.js";

// SAMPLE is typed as a registry so the literal narrows to Feed[],
// Agency[], etc. with the nulls on agency_id/agency_url that the
// spec schema requires. Built by parsing once through the schema
// at module load so the source of truth stays the spec.
const SAMPLE: FeedsRegistry = FeedsRegistrySchema.parse({
  version: "2026-07-08T00:30:00.000Z",
  generated_at: "2026-07-08T00:30:00.000Z",
  feeds: [
    {
      id: "cluj-napoca",
      name: "Cluj-Napoca",
      country: "RO",
      timezone: "Europe/Bucharest",
      bbox: { minLat: 46.7, minLon: 23.5, maxLat: 46.8, maxLon: 23.6 },
      center: { lat: 46.77, lon: 23.6 },
      agencies: [{ agency_name: "CTP Cluj-Napoca" }],
      source: { type: "transitous", publisher: "transitous", upstream_url: null },
      files: { sqlite_gz: "cluj-napoca-abc123def456.sqlite3.gz", gtfs_zip: null },
      size_bytes: { sqlite_gz: 1234, gtfs_zip: null },
      hash: "sha256-" + "0".repeat(64),
      generated_at: "2026-07-08T00:30:00.000Z",
      realtime: { vehicle_positions: "https://example.com/vp.pb" },
      license: { spdx_identifier: null, attribution_text: "© CTP", attribution_url: null },
    },
    {
      id: "bucuresti",
      name: "București",
      country: "RO",
      timezone: "Europe/Bucharest",
      bbox: { minLat: 44.3, minLon: 25.9, maxLat: 44.5, maxLon: 26.2 },
      center: { lat: 44.43, lon: 26.1 },
      agencies: [{ agency_name: "STB" }],
      source: { type: "transitous", publisher: "transitous", upstream_url: null },
      files: { sqlite_gz: "bucuresti-def456abc789.sqlite3.gz", gtfs_zip: null },
      size_bytes: { sqlite_gz: 5678, gtfs_zip: null },
      hash: "sha256-" + "1".repeat(64),
      generated_at: "2026-07-08T00:30:00.000Z",
      realtime: null,
      license: { spdx_identifier: null, attribution_text: "© STB", attribution_url: null },
    },
  ],
});

describe("fetchFeedsRegistry", () => {
  it("loads a valid feeds.json from a local file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtfs-rt-feeds-"));
    try {
      const path = join(dir, "feeds.json");
      writeFileSync(path, JSON.stringify(SAMPLE));
      const registry = await fetchFeedsRegistry(path);
      expect(registry.feeds).toHaveLength(2);
      expect(registry.feeds[0]?.id).toBe("cluj-napoca");
      // Bbox is the spec's object shape, not a tuple. Catches a
      // future refactor that reintroduces the local schema.
      expect(registry.feeds[0]?.bbox).toEqual({ minLat: 46.7, minLon: 23.5, maxLat: 46.8, maxLon: 23.6 });
      // Nullable realtime works.
      expect(registry.feeds[1]?.realtime).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on a malformed feeds.json (bbox as tuple — the pre-#74 drift)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gtfs-rt-feeds-"));
    try {
      const path = join(dir, "feeds.json");
      // The legacy rt package's local schema accepted bbox as a
      // tuple. The promoted spec schema is the source of truth
      // and uses the object shape from the static pipeline's
      // feeds.schema.json. A tuple should now fail validation.
      const drifted = {
        ...SAMPLE,
        feeds: [{ ...SAMPLE.feeds[0]!, bbox: [46.7, 23.5, 46.8, 23.6] }],
      };
      writeFileSync(path, JSON.stringify(drifted));
      await expect(fetchFeedsRegistry(path)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filterEnabled", () => {
  const feeds = SAMPLE.feeds;

  it("returns all feeds when enabledIds is empty", () => {
    expect(filterEnabled(feeds, [])).toEqual(feeds);
  });

  it("filters to the requested ids", () => {
    const result = filterEnabled(feeds, ["cluj-napoca"]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("cluj-napoca");
  });

  it("returns empty array when no ids match", () => {
    expect(filterEnabled(feeds, ["unknown"])).toEqual([]);
  });
});
