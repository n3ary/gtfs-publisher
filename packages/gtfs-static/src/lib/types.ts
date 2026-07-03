/**
 * Shared types for the static pipeline.
 *
 * These mirror the GTFS spec and the shape the app expects in feeds.json.
 * Kept here (not in @neary-gtfs/shared yet) until issue #34 step 3
 * promotes them.
 */

export type SourceType = 'transitous' | 'mobility-database' | 'remote';

export type Realtime = {
  vehicle_positions?: string;
  trip_updates?: string;
  service_alerts?: string;
};

export type FeedSource = {
  type: SourceType;
  publisher: string;
  upstream_url: string | null;
  upstream_etag?: string | null;
};

export type License = {
  spdx_identifier: string | null;
  attribution_text: string;
  attribution_url: string | null;
};

export type Feed = {
  id: string;
  name: string;
  country: string;
  region?: string | null;
  timezone: string | null;
  languages: string[];
  source: FeedSource;
  agencies: Array<{ agency_id: string | null; agency_name: string; agency_url: string | null }>;
  realtime: Realtime | null;
  license: License;
  _smoke?: { expectedPublisher?: string; tripIdPattern?: string } | null;
  _currentEtag?: string | null;
};

export type Agency = { agency_id: string | null; agency_name: string; agency_url: string | null };

export type Bbox = { minLat: number; minLon: number; maxLat: number; maxLon: number };
export type Center = { lat: number; lon: number };
export type Validity = { from: string | null; until: string | null };

export type DerivedMeta = {
  bbox: Bbox;
  center: Center;
  agencies: Agency[];
  timezone: string | null;
  validity: Validity;
};

export type GtfsFile = {
  localPath: string | null;
  sizeBytes: number | null;
  hash: string | null;
};

export type SqliteFile = {
  localPath: string;
  sizeBytes: number;
  hash: string;
};

export type FreshEntry = {
  feed: Feed;
  gtfs: GtfsFile;
  sqlite: SqliteFile | null;
  upstreamEtag: string | null;
} & DerivedMeta;

export type ReusedEntry = {
  reused: true;
  prevEntry: unknown;
};

export type FeedEntry = FreshEntry | ReusedEntry;