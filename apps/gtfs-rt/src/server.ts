/**
 * server.ts — Fastify HTTP server.
 *
 * Endpoints:
 *   GET /healthz                 — liveness/readiness, 200 always
 *   GET /feeds                   — debug: list of feeds + last-poll info
 *   GET /rt/:feed/vehicle_positions — clean GTFS-RT protobuf bytes
 *
 * The CF Worker passthrough (Step 10) will sit in front of this for
 * edge caching. The 5s Cache-Control header here is a backstop for
 * when the Worker isn't routing correctly.
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { getClean, listClean } from './store.js';
import { quirkFeedIds } from './quirks/index.js';

export interface ServerHandle {
  app: FastifyInstance;
  /** Start listening. Resolves to the bound URL once the socket is up. */
  listen(host: string, port: number): Promise<string>;
  /** Close the server. */
  close(): Promise<void>;
}

export function buildServer(log: FastifyBaseLogger): ServerHandle {
  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: true,
    bodyLimit: 1,
  });

  // CORS is permissive: the CF Worker + the consumer's PWA are the
  // only callers, and CORS is enforced at the Worker layer. The
  // allow-origin * here is fine because the body is opaque protobuf.
  void app.register(cors, { origin: '*' });

  app.get('/healthz', async () => ({
    status: 'ok',
    quirks: quirkFeedIds(),
    feeds: listClean().map((s) => ({
      feedId: s.feedId,
      fetchedAt: s.fetchedAt.toISOString(),
      appliedAt: s.appliedAt.toISOString(),
      entityCount: s.entityCount,
    })),
  }));

  app.get('/feeds', async () => ({
    feeds: listClean().map((s) => ({
      feedId: s.feedId,
      fetchedAt: s.fetchedAt.toISOString(),
      appliedAt: s.appliedAt.toISOString(),
      entityCount: s.entityCount,
    })),
  }));

  app.get<{ Params: { feed: string } }>('/rt/:feed/vehicle_positions', async (req, reply): Promise<void> => {
    const snap = getClean(req.params.feed);
    if (!snap) {
      await reply.code(404).send({ error: 'no snapshot for feed', feedId: req.params.feed });
      return;
    }
    await reply
      .header('Content-Type', 'application/x-protobuf')
      .header('Cache-Control', 'public, max-age=5')
      .header('X-Feed-Id', snap.feedId)
      .header('X-Fetched-At', snap.fetchedAt.toISOString())
      .header('X-Entity-Count', String(snap.entityCount))
      .send(Buffer.from(snap.bytes));
  });

  return {
    app,
    listen: (host, port) => app.listen({ host, port }),
    close: () => app.close(),
  };
}
