/**
 * server.test.ts — smoke test for the Fastify server.
 *
 * Boots the server on an ephemeral port, hits /healthz, and confirms
 * the response shape. The store is empty (no pollers), so /feeds
 * returns { feeds: [] } and /rt/.../vehicle_positions returns 404.
 *
 * Real end-to-end testing (with a mock upstream returning valid
 * protobuf) lands once a test harness exists; for now this guards
 * against the obvious regressions (server doesn't start, routes
 * aren't registered, etc.).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pino } from 'pino';
import { buildServer, type ServerHandle } from './server.js';

describe('server', () => {
  let server: ServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    const log = pino({ level: 'silent' });
    server = buildServer(log);
    await server.listen('127.0.0.1', 0);
    const addr = server.app.server.address();
    if (typeof addr !== 'object' || !addr) throw new Error('server not bound');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /healthz returns 200 + status ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; feeds: unknown[]; quirks: string[] };
    expect(body.status).toBe('ok');
    expect(Array.isArray(body.feeds)).toBe(true);
    expect(Array.isArray(body.quirks)).toBe(true);
  });

  it('GET /feeds returns the (empty) store', async () => {
    const res = await fetch(`${baseUrl}/feeds`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { feeds: unknown[] };
    expect(body.feeds).toEqual([]);
  });

  it('GET /rt/<unknown>/vehicle_positions returns 404', async () => {
    const res = await fetch(`${baseUrl}/rt/does-not-exist/vehicle_positions`);
    expect(res.status).toBe(404);
  });
});
