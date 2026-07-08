/**
 * Public re-exports for the quirks layer.
 *
 * This module is intentionally feed-agnostic -- no per-feed name
 * appears here. Per-feed quirks are loaded from
 * `feeds/<feedId>/config.json` at runtime by `./loader.js`.
 */
export { loadQuirk, clearQuirkCache, quirkFeedIds } from './loader.js';
export type { FeedConfig } from './loader.js';
export type { Quirk } from './types.js';
