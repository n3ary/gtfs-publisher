/**
 * config.ts — env-driven config for the RT adapter.
 *
 * All values come from process.env with sensible defaults. The adapter
 * is designed to run on a single Hetzner CX22 (per the deployment plan
 * in issue #34), so the config is intentionally flat — no config file,
 * no secret store, just env vars managed by systemd's EnvironmentFile.
 */
import { z } from 'zod';

const ConfigSchema = z.object({
  /** URL or local file path of the feeds.json registry. */
  feedsJson: z.string().min(1),

  /** Port the Fastify server listens on. */
  port: z.coerce.number().int().min(1).max(65535).default(8080),

  /** Host interface. Default 0.0.0.0 so systemd can supervise it. */
  host: z.string().default('0.0.0.0'),

  /** Per-feed poll interval in milliseconds. Default 15s. */
  pollIntervalMs: z.coerce.number().int().min(1000).default(15_000),

  /** Upstream fetch timeout in milliseconds. */
  upstreamTimeoutMs: z.coerce.number().int().min(1000).default(10_000),

  /** Log level (fatal|error|warn|info|debug|trace). */
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  /** Comma-separated list of feed IDs to enable. Empty = all. */
  enabledFeeds: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    feedsJson: env.FEEDS_JSON ?? '',
    port: env.PORT,
    host: env.HOST,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    enabledFeeds: env.ENABLED_FEEDS,
  };
  return ConfigSchema.parse(raw);
}
