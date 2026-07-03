/**
 * Pipeline-orchestration types. NOT published as part of the
 * `@ciotlosm/neary-gtfs-core` library — these describe how the
 * static pipeline sources, derives metadata for, and serializes a
 * feed entry, which is specific to this repo's build logic.
 *
 * Pure GTFS-spec types (Agency, Bbox/Center/Validity, Realtime,
 * License) moved to `@n3ary/neary-gtfs-spec/schema` in issue #34 step 3.
 * Re-exported here so existing import paths keep working.
 */

import type { Agency, Bbox, Center, Realtime, Validity, License } from '@n3ary/neary-gtfs-spec/schema';

export type { Agency, Bbox, Center, Realtime, Validity, License };

export type SourceType = 'transitous' | 'mobility-database' | 'remote';

export type FeedSource = {
  type: SourceType;
  publisher: string;
  upstream_url: string | null;
  upstream_etag?: string | null;
};

export type Feed = {
  id: string;
  name: string;
  country: string;
  region?: string | null;
  timezone: string | null;
  languages: string[];
  source: FeedSource;
  agencies: Agency[];
  realtime: Realtime | null;
  license: License;
  _smoke?: { expectedPublisher?: string; tripIdPattern?: string } | null;
  _currentEtag?: string | null;
};

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