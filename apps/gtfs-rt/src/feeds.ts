/**
 * feeds.ts — load and zod-validate the feeds.json registry.
 *
 * The RT adapter only needs the per-feed `realtime` URLs, but we
 * validate the whole registry against the shared @n3ary/gtfs-spec
 * schema so a malformed feeds.json fails fast at startup instead
 * of silently serving nothing.
 *
 * The per-feed schema is defined here locally — the @n3ary/gtfs-spec
 * package exposes the sub-shapes (Agency, Realtime, License) but
 * not yet a top-level Feed composition. Promoting `Feed` to the
 * spec package is a follow-up; this local definition mirrors the
 * spec to keep the adapter honest.
 *
 * Supports both local paths (file://... or /abs/path) and HTTP(S)
 * URLs. The producer (gtfs-static) ships feeds.json to R2 under
 * https://gtfs.n3ary.com/feeds.json — the Hetzner adapter hits that
 * URL on startup and refreshes every N hours.
 */
import { readFile } from 'node:fs/promises';
import { AgencySchema, LicenseSchema, RealtimeSchema } from '@n3ary/gtfs-spec/schema';
import { z } from 'zod';

const FeedSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    country: z.string().length(2),
    timezone: z.string(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
    center: z.tuple([z.number(), z.number()]).optional(),
    agencies: z.array(AgencySchema),
    files: z.object({ sqlite_gz: z.string() }),
    size_bytes: z.object({ sqlite_gz: z.number() }).optional(),
    hash: z.string(),
    realtime: RealtimeSchema.optional(),
    license: LicenseSchema.optional(),
  })
  .passthrough();

const FeedsRegistrySchema = z.object({
  version: z.string(),
  generated_at: z.string(),
  feeds: z.array(FeedSchema),
});

export type FeedsRegistry = z.infer<typeof FeedsRegistrySchema>;

export type ResolvedFeed = FeedsRegistry['feeds'][number];

/**
 * Resolve `source` to a feeds.json string. Accepts:
 *   - http://... or https://...  (fetch)
 *   - file:///abs/path or /abs/path (readFile)
 *   - relative path (resolved against cwd)
 */
export async function fetchFeedsRegistry(source: string): Promise<FeedsRegistry> {
  const text = await loadText(source);
  return FeedsRegistrySchema.parse(JSON.parse(text));
}

async function loadText(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`failed to fetch feeds.json from ${source}: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }
  const path = source.startsWith('file://') ? new URL(source).pathname : source;
  return readFile(path, 'utf8');
}

/**
 * Filter to enabled feeds. If `enabledIds` is empty, return all.
 */
export function filterEnabled(feeds: ResolvedFeed[], enabledIds: string[]): ResolvedFeed[] {
  if (enabledIds.length === 0) return feeds;
  const set = new Set(enabledIds);
  return feeds.filter((f) => set.has(f.id));
}
