/**
 * feeds.json registry — one FeedSchema per upstream, validated
 * against the static pipeline's Ajv schema (1:1 mirror).
 *
 * Strict: unknown keys are rejected. The JSON schema is the source
 * of truth — keep this file in sync with the `feeds.schema.json`
 * the static pipeline emits against.
 */

import { z } from "zod";
import { AgencySchema } from "./agency.js";
import { BboxSchema, CenterSchema } from "./geometry.js";
import { LicenseSchema } from "./license.js";
import { RealtimeSchema } from "./realtime.js";

const SourceTypeSchema = z.enum(["transitous", "mobility-database", "remote", "adapter"]);

const SourceSchema = z
  .object({
    type: SourceTypeSchema,
    publisher: z.string().min(1),
    upstream_url: z.string().url().nullable(),
    upstream_etag: z.string().nullable().optional(),
  })
  .strict();

const FilesSchema = z
  .object({
    sqlite_gz: z.string().min(1),
    gtfs_zip: z.string().min(1).nullable(),
  })
  .strict();

const SizeBytesSchema = z
  .object({
    sqlite_gz: z.number().int().nonnegative(),
    gtfs_zip: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const FeedSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "expected slug like a-z, 0-9, dashes"),
    name: z.string().min(1),
    country: z.string().regex(/^[A-Z]{2}$/, "expected ISO 3166-1 alpha-2 country code"),
    region: z.string().optional(),
    timezone: z.string().min(1),
    languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).optional(),
    bbox: BboxSchema,
    center: CenterSchema,
    agencies: z.array(AgencySchema).min(1),
    source: SourceSchema,
    files: FilesSchema,
    size_bytes: SizeBytesSchema,
    hash: z.string().regex(/^sha256-[a-f0-9]{64}$/, "expected sha256-<64hex>"),
    generated_at: z.string().datetime(),
    valid_from: z.string().nullable().optional(),
    valid_until: z.string().nullable().optional(),
    realtime: RealtimeSchema.nullable(),
    license: LicenseSchema,
  })
  .strict();

export type Feed = z.infer<typeof FeedSchema>;

// `version` mirrors `generated_at` for forward-compat (the pipeline
// may move to a semver-like scheme later) — keep both in the schema
// so consumers don't break on the switch.
export const FeedsRegistrySchema = z
  .object({
    version: z.string().datetime(),
    generated_at: z.string().datetime(),
    feeds: z.array(FeedSchema).min(1),
  })
  .strict();

export type FeedsRegistry = z.infer<typeof FeedsRegistrySchema>;
