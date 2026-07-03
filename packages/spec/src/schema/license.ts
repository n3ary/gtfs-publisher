/**
 * Feed-license metadata. The exact fields aren't part of the GTFS
 * spec itself (GTFS carries them as free-text fields in
 * `feed_info.txt`); this shape is the published-registry contract
 * that downstream consumers rely on.
 *
 * SPDX identifier is the canonical machine-readable license form
 * (https://spdx.org/licenses/). attribution_text and attribution_url
 * are display strings consumers are required to render.
 */

import { z } from 'zod';

export const LicenseSchema = z.object({
  /** SPDX identifier, e.g. "MIT", "CC-BY-4.0". Null if the publisher didn't declare one. */
  spdx_identifier: z.string().nullable(),
  /** Human-readable attribution line, e.g. "© Compania de Transport Public Cluj-Napoca". */
  attribution_text: z.string().min(1),
  /** URL the consumer should link the attribution to. Null if no canonical URL exists. */
  attribution_url: z.string().url().nullable(),
}).strict();

export type License = z.infer<typeof LicenseSchema>;