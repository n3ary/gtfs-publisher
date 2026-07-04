/**
 * index.ts — entry point.
 *
 * Wires the config → feeds registry → per-feed poller → HTTP server.
 * Graceful shutdown on SIGTERM/SIGINT so systemd's TimeoutStopSec is
 * never hit.
 */
import { pino } from 'pino';
import { loadConfig } from './config.js';
import { fetchFeedsRegistry, filterEnabled } from './feeds.js';
import { startPolling, type PollHandle } from './poller.js';
import { buildServer, type ServerHandle } from './server.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = pino({ level: cfg.logLevel, transport: { target: 'pino-pretty' } });

  log.info({ cfg }, 'starting gtfs-rt adapter');

  const registry = await fetchFeedsRegistry(cfg.feedsJson);
  const enabled = filterEnabled(registry.feeds, cfg.enabledFeeds);
  log.info(
    { total: registry.feeds.length, enabled: enabled.length, ids: enabled.map((f) => f.id) },
    'feeds loaded',
  );

  const pollers: PollHandle[] = enabled.map((feed) =>
    startPolling(feed, cfg.pollIntervalMs, cfg.upstreamTimeoutMs, log.child({ feedId: feed.id })),
  );

  const server = buildServer(log);
  await server.listen(cfg.host, cfg.port);
  log.info({ host: cfg.host, port: cfg.port }, 'http server listening');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    for (const p of pollers) p.stop();
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err);
  process.exit(1);
});
