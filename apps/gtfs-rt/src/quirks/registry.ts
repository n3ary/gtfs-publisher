/**
 * Auto-register every quirk by importing it here. The registry maps
 * feed ID → Quirk. If a feed has no quirk registered, it falls through
 * unchanged (the upstream's bytes go straight to the store, quirks
 * step is a no-op for that feed).
 *
 * The cluj quirk is sourced from the per-feed adapter package
 * (@n3ary/gtfs-adapter-cluj-napoca/rt) as of v0.3.4 — see
 * n3ary/gtfs-publisher#91 for the refactor that moved it out.
 */
import { clujQuirk } from './index.js';
import type { Quirk } from './types.js';

const QUIRKS: Readonly<Record<string, Quirk>> = {
  'cluj-napoca': clujQuirk,
};

export function quirkFor(feedId: string): Quirk | undefined {
  return QUIRKS[feedId];
}

export function quirkFeedIds(): string[] {
  return Object.keys(QUIRKS);
}

export type { Quirk } from './types.js';
