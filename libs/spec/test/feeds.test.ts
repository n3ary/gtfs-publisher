import { describe, it, expect } from "vitest";
import { FeedSchema, FeedsRegistrySchema } from "../src/schema/feeds.js";

const MINIMAL_FEED = {
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
  realtime: {
    vehicle_positions: "https://example.com/vp.pb",
  },
  license: { spdx_identifier: null, attribution_text: "© CTP", attribution_url: null },
};

const MINIMAL_REGISTRY = {
  version: "2026-07-08T00:30:00.000Z",
  generated_at: "2026-07-08T00:30:00.000Z",
  feeds: [MINIMAL_FEED],
};

describe("FeedSchema", () => {
  it("parses a minimal valid feed", () => {
    const result = FeedSchema.parse(MINIMAL_FEED);
    expect(result.id).toBe("cluj-napoca");
    expect(result.realtime?.vehicle_positions).toBe("https://example.com/vp.pb");
    expect(result.files.gtfs_zip).toBeNull();
  });

  it("accepts a fully populated feed (region, languages, valid_* dates)", () => {
    const result = FeedSchema.parse({
      ...MINIMAL_FEED,
      region: "Transylvania",
      languages: ["ro", "en"],
      valid_from: "2026-01-01",
      valid_until: "2026-12-31",
      realtime: {
        vehicle_positions: "https://example.com/vp.pb",
        trip_updates: "https://example.com/tu.pb",
        service_alerts: "https://example.com/sa.pb",
      },
    });
    expect(result.region).toBe("Transylvania");
    expect(result.languages).toEqual(["ro", "en"]);
  });

  it("accepts realtime: null (no realtime for this feed)", () => {
    const result = FeedSchema.parse({ ...MINIMAL_FEED, realtime: null });
    expect(result.realtime).toBeNull();
  });

  it("rejects an invalid id (uppercase, spaces)", () => {
    expect(() =>
      FeedSchema.parse({ ...MINIMAL_FEED, id: "Cluj Napoca" }),
    ).toThrow();
  });

  it("rejects a non-2-letter country code", () => {
    expect(() => FeedSchema.parse({ ...MINIMAL_FEED, country: "romania" })).toThrow();
  });

  it("rejects bbox missing a corner", () => {
    expect(() =>
      FeedSchema.parse({
        ...MINIMAL_FEED,
        bbox: { minLat: 0, minLon: 0, maxLat: 0 },
      }),
    ).toThrow();
  });

  it("rejects a non-sha256 hash", () => {
    expect(() =>
      FeedSchema.parse({ ...MINIMAL_FEED, hash: "md5-deadbeef" }),
    ).toThrow();
  });

  it("rejects an empty agencies array (at least one agency is required)", () => {
    expect(() =>
      FeedSchema.parse({ ...MINIMAL_FEED, agencies: [] }),
    ).toThrow();
  });

  it("rejects an unknown source type", () => {
    expect(() =>
      FeedSchema.parse({
        ...MINIMAL_FEED,
        source: { ...MINIMAL_FEED.source, type: "made-up" },
      }),
    ).toThrow();
  });

  it("rejects unknown keys (strict mode)", () => {
    expect(() =>
      FeedSchema.parse({ ...MINIMAL_FEED, drift: "oops" }),
    ).toThrow();
  });
});

describe("FeedsRegistrySchema", () => {
  it("parses a minimal valid registry", () => {
    const result = FeedsRegistrySchema.parse(MINIMAL_REGISTRY);
    expect(result.feeds).toHaveLength(1);
    expect(result.feeds[0].id).toBe("cluj-napoca");
  });

  it("rejects an empty feeds array (at least one feed is required)", () => {
    expect(() =>
      FeedsRegistrySchema.parse({ ...MINIMAL_REGISTRY, feeds: [] }),
    ).toThrow();
  });

  it("rejects a feed entry that fails FeedSchema", () => {
    expect(() =>
      FeedsRegistrySchema.parse({
        ...MINIMAL_REGISTRY,
        feeds: [{ ...MINIMAL_FEED, id: "Bad ID" }],
      }),
    ).toThrow();
  });
});
