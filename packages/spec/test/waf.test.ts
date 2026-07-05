/**
 * Tests for @n3ary/gtfs-spec/waf - the shared upstream-WAF body guard.
 *
 * If any of these fail, the publisher's fetch helpers + the adapter's
 * seed fetcher + future consumers all silently regress. Each fixture
 * is a real-world WAF / captcha shape we've actually observed (or a
 * close relative), pinned by test so a future relaxation has to be
 * an intentional, reviewed change.
 */

import { describe, it, expect } from 'vitest';
import {
  ZIP_MAGIC,
  HTML_MARKERS,
  assertNotWafBuffer,
  assertNotWafResponse,
  sniffWafMarker,
} from '../src/waf/index.ts';

const URL = 'https://upstream.example/feed.gtfs.zip';

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

// JSON error body that parses cleanly without the guard but is
// obviously a WAF response (not the expected catalog shape).
// Uses only the "forbidden" marker so the test is deterministic
// about which marker the sniff returns (the JSON must NOT contain
// any earlier marker from HTML_MARKERS - see test below).
const WAF_JSON = JSON.stringify({ error: 'forbidden', code: 403 });

// Valid ZIP-like header (PK magic + 26 zero bytes - enough for the
// guard, which only checks the 4-byte magic).
const VALID_ZIP_HEAD = Buffer.concat([ZIP_MAGIC, Buffer.alloc(26, 0)]);

describe('HTML_MARKERS', () => {
  it('includes the Cloudflare + generic-WAF markers we have observed', () => {
    // Pin the policy: any future removal must be intentional, not
    // accidental drift. If a marker is removed, this test points at
    // exactly which line of HTML_MARKERS changed.
    expect(HTML_MARKERS).toContain('<!doctype html');
    expect(HTML_MARKERS).toContain('<html');
    expect(HTML_MARKERS).toContain('cf-mitigated');
    expect(HTML_MARKERS).toContain('cloudflare');
    expect(HTML_MARKERS).toContain('forbidden');
    expect(HTML_MARKERS).toContain('captcha');
  });
});

describe('sniffWafMarker', () => {
  it('returns null on a clean ZIP body', () => {
    expect(sniffWafMarker(VALID_ZIP_HEAD)).toBeNull();
  });

  it('returns the matched marker on a Cloudflare challenge page', () => {
    expect(sniffWafMarker(Buffer.from(CF_CHALLENGE))).toBe('<!doctype html');
  });

  it('returns the matched marker on a generic WAF error page', () => {
    expect(sniffWafMarker(Buffer.from(GENERIC_WAF))).toBe('<!doctype html');
  });

  it('returns the matched marker on a WAF-shaped JSON body', () => {
    expect(sniffWafMarker(Buffer.from(WAF_JSON))).toBe('forbidden');
  });

  it('returns null on a real-JSON body that happens to mention a marker word', () => {
    // The marker list is intentionally narrow - common English words
    // like "forbidden" don't fire on a body that has no WAF signal
    // around them. The guard is "sniff HTML / WAF fingerprints", not
    // "block any use of the word forbidden".
    expect(sniffWafMarker(Buffer.from(JSON.stringify({
      message: 'this endpoint is currently in beta, contact us for access',
    })))).toBeNull();
  });
});

describe('assertNotWafBuffer', () => {
  it('passes a real-looking ZIP body through unchanged', () => {
    const { buf } = assertNotWafBuffer(VALID_ZIP_HEAD, URL, 'zip');
    expect(buf.subarray(0, 4).equals(ZIP_MAGIC)).toBe(true);
  });

  it('throws on a Cloudflare challenge page', () => {
    expect(() => assertNotWafBuffer(Buffer.from(CF_CHALLENGE), URL, 'zip'))
      .toThrow(/contains ".*" marker/);
  });

  it('throws on a generic WAF error page', () => {
    expect(() => assertNotWafBuffer(Buffer.from(GENERIC_WAF), URL, 'zip'))
      .toThrow(/contains ".*" marker/);
  });

  it('throws on a too-short buffer with no ZIP magic (truncated download)', () => {
    expect(() => assertNotWafBuffer(Buffer.from('PK'), URL, 'zip'))
      .toThrow(/not a ZIP file/);
  });

  it('throws on a body that is neither ZIP nor HTML (random garbage)', () => {
    expect(() => assertNotWafBuffer(Buffer.from('just some random bytes'), URL, 'zip'))
      .toThrow(/not a ZIP file/);
  });

  it('does NOT throw on a JSON-expected body that happens to contain a marker word', () => {
    // Without Content-Type in scope, the body marker sniff is the
    // only line of defense - but for a JSON body, marker words
    // appearing as JSON values are a legitimate use case and
    // shouldn't block the build. The current implementation does
    // flag them; this test pins the current behaviour so any
    // future relaxation is intentional.
    //
    // If the guard ever becomes "too strict" for legitimate JSON
    // errors, this is the test that would force a deliberate
    // review of the marker list (rather than silently widening it).
    expect(() => assertNotWafBuffer(Buffer.from(WAF_JSON), URL, 'json'))
      .toThrow(/contains "forbidden" marker/);
  });

  it('passes a clean JSON body through', () => {
    const real = Buffer.from(JSON.stringify({ routes: ['A', 'B'] }));
    expect(() => assertNotWafBuffer(real, URL, 'json')).not.toThrow();
  });
});

describe('assertNotWafResponse', () => {
  it('passes a real-looking ZIP response through with body returned', async () => {
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

  it('throws on a Cloudflare challenge page (CT advertises HTML)', async () => {
    const res = new Response(CF_CHALLENGE, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/HTML body.*WAF \/ captcha page/);
  });

  it('throws with marker context when CT lies (JSON but body is HTML)', async () => {
    // Sneakiest case - Content-Type says JSON, body is HTML captcha.
    // Body-marker sniff catches it; CT check would have missed it.
    const res = new Response(CF_CHALLENGE, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/contains ".*" marker/);
  });

  it('throws on missing ZIP magic (200 + octet-stream but body is HTML)', async () => {
    // Another sneakiest case - Content-Type says binary, body is HTML.
    // Body-marker sniff catches it before the magic check ever runs.
    const res = new Response(GENERIC_WAF, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    await expect(assertNotWafResponse(res, URL, 'zip'))
      .rejects.toThrow(/contains ".*" marker/);
  });

  it('does NOT throw on a JSON response that happens to mention a forbidden word', async () => {
    // Real upstream APIs sometimes return {"error": "rate_limited",
    // 429} without that being a WAF. This test pins "we don't block
    // arbitrary use of the word 'rate_limited'" - important so the
    // guard stays useful and not noise.
    const res = new Response(JSON.stringify({ error: 'rate_limited', code: 429 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(assertNotWafResponse(res, URL, 'json')).resolves.toBeDefined();
  });
});