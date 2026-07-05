/**
 * Tests for the WAF body guard in packages/gtfs-static/src/lib/http.ts.
 *
 * The guard is the load-bearing piece - if it ever stops catching a
 * Cloudflare / captcha page, the daily pipeline ships a poisoned
 * SQLite and the consumer app's "stops near me" crashes on garbage
 * data. Each fixture below is a real-world shape we've actually
 * observed (or a close relative), pinned by test so a future
 * relaxation has to be an intentional, reviewed change.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { fetchJson, fetchToFile } from '../src/lib/http.ts';
import {
  assertNotWafResponse,
  ZIP_MAGIC,
} from '@n3ary/gtfs-spec/waf';

const URL = 'https://upstream.example/feed.gtfs.zip';

// Minimal valid zip header for "happy path" fixtures.
// 'PK\x03\x04' + version + flags + compression + ... truncated is fine
// for the guard - it only checks the 4-byte magic.
const VALID_ZIP_HEAD = Buffer.concat([ZIP_MAGIC, Buffer.alloc(26, 0)]);

// Real-world Cloudflare challenge page (close-enough excerpt).
const CF_CHALLENGE = `<!DOCTYPE html>
<html lang="en">
<head><title>Just a moment...</title></head>
<body>
<h1>Checking your browser before accessing api.transitous.org.</h1>
<script>cf-mitigated</script>
</body>
</html>`;

// Generic WAF error page (no Cloudflare marker but obviously HTML).
const GENERIC_WAF = `<!doctype html><html><body>Access denied - request blocked.</body></html>`;

// JSON error body that would parse cleanly without the guard but is
// obviously a WAF response (not the expected catalog shape).
const WAF_JSON = JSON.stringify({ error: 'forbidden', reason: 'access denied' });

describe('assertNotWafResponse', () => {
  it('passes a real-looking ZIP body through unchanged', async () => {
    const res = new Response(VALID_ZIP_HEAD, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const { buf } = await assertNotWafResponse(res, URL, 'zip');
    expect(buf.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('throws on Content-Type: text/html even if body looks zip-shaped', async () => {
    const res = new Response(VALID_ZIP_HEAD, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/HTML body.*WAF \/ captcha page/);
  });

  it('throws on a Cloudflare challenge page (markers in body)', async () => {
    const res = new Response(CF_CHALLENGE, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/HTML body.*WAF \/ captcha page/);
  });

  it('throws on a generic WAF error page even without Content-Type: text/html', async () => {
    // Some WAFs strip the Content-Type header entirely. Body sniff
    // is the last line of defense.
    const res = new Response(GENERIC_WAF, {
      status: 200,
      headers: {},
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/contains ".*" marker/);
  });

  it('throws on missing ZIP magic (200 + octet-stream but body is HTML)', async () => {
    // Sneakiest case: 200, Content-Type lies about being a binary,
    // body is HTML. Marker sniff catches it before we ever read the
    // ZIP magic (the marker list is checked first - cheaper + more
    // informative error than the magic mismatch).
    const res = new Response(GENERIC_WAF, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/contains ".*" marker/);
  });

  it('throws when ZIP body is too short to have magic bytes', async () => {
    const res = new Response(Buffer.from('PK'), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/not a ZIP file/);
  });

  it('does NOT throw on a json-expected body that happens to be a real JSON error', async () => {
    // {"error": "forbidden"} - if this is real upstream data (not a WAF),
    // the guard must not block it. "forbidden" matches the marker list,
    // so we deliberately use a non-marker error message here.
    const realJson = JSON.stringify({ error: 'rate_limited', code: 429 });
    const res = new Response(realJson, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const { buf } = await assertNotWafResponse(res, URL, 'json');
    expect(JSON.parse(buf.toString('utf8'))).toEqual({ error: 'rate_limited', code: 429 });
  });

  it('throws on a WAF-shaped JSON body (error message contains a marker)', async () => {
    const res = new Response(WAF_JSON, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(assertNotWafResponse(res, URL, 'json'))
      .rejects.toThrow(/contains ".*" marker/);
  });
});

describe('fetchJson', () => {
  it('throws with URL + content-type context when upstream returns a WAF page', async () => {
    // Content-Type check fires first (it's the cheap path), so the
    // body-marker sniff is the second line of defense. This test pins
    // both: when CT advertises HTML, the error names the URL +
    // content-type; when CT lies, the marker sniff names the URL +
    // marker (covered by the next test).
    const fetchMock = vi.fn(async () =>
      new Response(CF_CHALLENGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchJson('https://upstream.example/catalog.json'))
        .rejects.toThrow(/upstream.example.*HTML body.*WAF/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws with marker context when upstream returns a WAF page with a lying Content-Type', async () => {
    // Body sniff path: CT says JSON but the body is HTML captcha.
    // Critical case - this is what tripped the daily pipeline
    // silently before the guard existed.
    const fetchMock = vi.fn(async () =>
      new Response(CF_CHALLENGE, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchJson('https://upstream.example/catalog.json'))
        .rejects.toThrow(/upstream.example.*marker/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns parsed JSON on a real JSON response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ routes: ['A', 'B'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await fetchJson('https://upstream.example/catalog.json');
      expect(result).toEqual({ routes: ['A', 'B'] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws a clear error when JSON.parse fails (not a WAF, just malformed)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('not actually json {{{', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchJson('https://upstream.example/catalog.json'))
        .rejects.toThrow(/not valid JSON/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('fetchToFile', () => {
  it('writes a real ZIP body to disk unchanged', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fetchToFile-'));
    const dest = join(tmp, 'feed.zip');
    const fetchMock = vi.fn(async () =>
      new Response(VALID_ZIP_HEAD, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await fetchToFile('https://upstream.example/feed.gtfs.zip', dest);
      const onDisk = readFileSync(dest);
      expect(onDisk.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does NOT write a WAF page to disk (no orphan file)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fetchToFile-'));
    const dest = join(tmp, 'feed.zip');
    const fetchMock = vi.fn(async () =>
      new Response(CF_CHALLENGE, {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchToFile('https://upstream.example/feed.gtfs.zip', dest))
        .rejects.toThrow(/HTML body.*WAF \/ captcha page/);
      // Critical: the failed write must leave nothing behind. If
      // the old behavior came back, this would fail - the test
      // pins "fail loud AND fail clean".
      expect(() => readFileSync(dest)).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does NOT write a body with wrong magic bytes to disk', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'fetchToFile-'));
    const dest = join(tmp, 'feed.zip');
    // Body sniff path - Content-Type lies (says octet-stream) but
    // the body is HTML. The marker sniff catches "<!doctype html"
    // before we ever check the ZIP magic. This is the exact pattern
    // that poisoned the consumer's SQLite last time.
    const fetchMock = vi.fn(async () =>
      new Response(GENERIC_WAF, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchToFile('https://upstream.example/feed.gtfs.zip', dest))
        .rejects.toThrow(/<!doctype html/);
      expect(() => readFileSync(dest)).toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws on non-2xx status BEFORE running the guard (cheaper path)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('upstream down', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(fetchToFile('https://upstream.example/feed.gtfs.zip', '/tmp/nope.zip'))
        .rejects.toThrow(/HTTP 503/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});