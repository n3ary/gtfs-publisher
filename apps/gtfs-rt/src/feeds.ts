/**
 * feeds.ts — load and zod-validate feeds.json against the shared
 * @n3ary/gtfs-spec schema. The `Feed` / `FeedsRegistry` shapes live
 * in the spec package (promoted in https://github.com/n3ary/gtfs-publisher/issues/74
 * step 3) so the static pipeline's Ajv schema and the consumers'
 * zod schema stay in sync from one place.
 *
 * Supports both local paths (file://... or /abs/path) and HTTP(S)
 * URLs. The producer (gtfs-static) ships feeds.json to R2 under
 * https://gtfs.n3ary.com/feeds.json.
 */
import { readFile } from "node:fs/promises";
import { FeedsRegistrySchema, type FeedsRegistry } from "@n3ary/gtfs-spec/schema";

export type { FeedsRegistry } from "@n3ary/gtfs-spec/schema";
export type ResolvedFeed = FeedsRegistry["feeds"][number];

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
  const path = source.startsWith("file://") ? new URL(source).pathname : source;
  return readFile(path, "utf8");
}

export function filterEnabled(feeds: ResolvedFeed[], enabledIds: string[]): ResolvedFeed[] {
  if (enabledIds.length === 0) return feeds;
  const set = new Set(enabledIds);
  return feeds.filter((f) => set.has(f.id));
}
