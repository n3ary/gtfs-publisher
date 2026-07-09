#!/usr/bin/env node
/**
 * compare-server.mjs -- local companion server for compare-vehicle-positions.html.
 *
 * Why this exists: the HTML opens from file://, which the browser
 * marks as origin "null". Modern browsers refuse to let a null
 * origin fetch from production endpoints (Hetzner / Cloudflare
 * Pages Functions) because those endpoints don't return
 * Access-Control-Allow-Origin: null. CORS by design.
 *
 * This server gives the HTML a real origin (http://localhost:8765)
 * and a same-origin /api/fetch proxy endpoint. The HTML's fetch
 * calls go to /api/fetch?url=<encoded upstream>; this server
 * makes the upstream request server-side (no CORS in Node's http
 * module), then returns the body with Access-Control-Allow-Origin: *
 * to satisfy the browser. The upstream itself never sees a CORS
 * request.
 *
 * Usage:
 *   node compare-server.mjs            # listens on 127.0.0.1:8765
 *   node compare-server.mjs 9000       # custom port
 *   PORT=9000 node compare-server.mjs  # same, via env var
 *
 * Then open http://localhost:8765/ in a browser. The HTML is
 * served from the same origin, so all the inline scripts and
 * the /api/fetch calls succeed. Press Ctrl-C to stop.
 *
 * Security notes:
 *   - Binds to 127.0.0.1 only; not reachable from the network.
 *   - Proxy is open to any URL the operator types. Fine for a
 *     dev tool; not what you'd ship to a multi-tenant host.
 *   - 15 s upstream timeout; no response caching.
 *   - Forwards the upstream's Content-Type so the HTML can decide
 *     whether the body is protobuf or an error.
 */

import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'compare-vehicle-positions.html');
const PORT = parseInt(process.env.PORT || process.argv[2] || '8765', 10);
const HOST = '127.0.0.1';
const UPSTREAM_TIMEOUT_MS = 15000;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function proxyFetch(targetUrl) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); }
    catch { return reject(new Error('invalid url: ' + targetUrl)); }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reject(new Error('unsupported protocol: ' + parsed.protocol));
    }
    const lib = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = lib({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        // Hetzner / Cloudflare's bot-fight mode discriminates by
        // TLS fingerprint, not UA, but a CF cache rule is fine
        // with a real UA. The upstream doesn't need anything
        // exotic for a static GTFS-RT response.
        'user-agent': 'neary-compare-server/1 (local dev tool)',
        'accept': 'application/x-protobuf, application/octet-stream, */*',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      req.destroy(new Error('upstream timeout after ' + UPSTREAM_TIMEOUT_MS + 'ms'));
    });
    req.end();
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight (browsers send OPTIONS before a same-origin GET
  // is harmless, but some extensions / debugging paths don't).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // The proxy endpoint the HTML uses.
  if (url.pathname === '/api/fetch') {
    const target = url.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'missing ?url= param' }));
    }
    try {
      const upstream = await proxyFetch(target);
      res.writeHead(upstream.status, {
        ...CORS_HEADERS,
        'content-type': upstream.headers['content-type'] || 'application/octet-stream',
        'x-proxied-from': target,
        'x-proxied-status': String(upstream.status),
        'x-proxy-upstream-time-ms': String(upstream.headers['x-response-time'] || ''),
      });
      return res.end(upstream.body);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'application/json', ...CORS_HEADERS });
      return res.end(JSON.stringify({ error: 'upstream error: ' + e.message }));
    }
  }

  // Serve the HTML at the root.
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = readFileSync(HTML_PATH);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('failed to read compare-vehicle-positions.html: ' + e.message + '\n\n' +
        'Make sure compare-server.mjs sits next to compare-vehicle-positions.html in apps/gtfs-rt/scripts/.');
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain', ...CORS_HEADERS });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  console.log(`compare-server listening on http://${HOST}:${PORT}/`);
  console.log(`open this URL in a browser to use the visual compare tool`);
  console.log(`proxy endpoint: GET /api/fetch?url=<encoded URL>`);
  console.log(`Ctrl-C to stop`);
});