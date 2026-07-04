/**
 * Auto-register every quirk by importing it here. The registry maps
 * feed ID → Quirk. If a feed has no quirk registered, it falls through
 * unchanged (the upstream's bytes go straight to the store, quirks
 * step is a no-op for that feed).
 */
import { clujQuirk } from './cluj.js';
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
