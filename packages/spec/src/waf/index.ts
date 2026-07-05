/**
 * @n3ary/gtfs-spec/waf - HTTP response body WAF / captcha guard.
 *
 * Shared by every consumer that fetches upstream GTFS or GTFS-adjacent
 * data (publisher, feed adapters). Centralised here so a new WAF
 * fingerprint only needs adding in one place.
 *
 * Upstream sources (Transitous, Tranzy, MDB, ctpcj.ro, ...) have all
 * been seen returning HTTP 200 + a Cloudflare challenge page or
 * captcha HTML body when their edge rate-limits us. A plain
 * `res.ok` check lets it through; downstream code then writes the
 * HTML to disk labelled `.gtfs.zip` / parses it as JSON / merges it
 * as a GTFS CSV - either failing loudly later or, worse, parsing
 * garbage rows into a SQLite that ships to consumers. The most
 * recent victim was the 14:42 + 15:56 UTC 2026-07-05 daily runs:
 * "stops near me" crashed on bogus SQL.
 *
 * Three layers of detection:
 *
 *   1. Content-Type advertises HTML when it shouldn't be
 *      (cheap header check; the common Cloudflare shape).
 *   2. First ~1 KB of the body contains a known WAF marker
 *      (catches WAFs that strip / mislabel Content-Type).
 *   3. For ZIP fetches: the PK\\x03\\x04 magic bytes are absent
 *      (last line of defense - a 200 + application/octet-stream +
 *      HTML body would slip past #1 + #2).
 *
 * On a hit, the guard throws with the URL + the sniffed marker /
 * preview so the build fails loudly. Callers should let the error
 * propagate - the publisher's daily.yml sets `STRICT=true` so a
 * thrown error exits the job non-zero and no feeds.json + sqlite.gz
 * get published.
 */

// Local file header magic: 'PK\x03\x04'. Matches real .gtfs.zip files.
export const ZIP_MAGIC: Buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Markers commonly seen in Cloudflare / generic WAF challenge pages.
 * Sniffed case-insensitively against the first ~1 KB of the body.
 *
 * Order matters: the first match in the array wins. Keep the most
 * specific markers (e.g. `<!doctype html`, `cf-mitigated`) at the
 * top so the error message names the actual issue rather than a
 * generic "forbidden".
 */
export const HTML_MARKERS: readonly string[] = [
  '<!doctype html',
  '<html',
  'cloudflare',
  'attention required',
  'cf-mitigated',
  'just a moment',
  'checking your browser',
  'access denied',
  'forbidden',
  'captcha',
] as const;

/** What kind of payload the caller expects. Drives the ZIP-magic check. */
export type ExpectedKind = 'zip' | 'json' | 'csv';

export interface GuardOk {
  /** Body bytes, valid. Returned so callers can re-use without re-downloading. */
  buf: Buffer;
}

const WAF_SNIFF_BYTES = 1024;
const MAGIC_PREVIEW_BYTES = 64;

function looksLikeHtml(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('application/xhtml+xml');
}

/**
 * Sniff the first ~1 KB of the body for HTML/WAF markers.
 * Returns the first matched marker (case-insensitive), or null
 * if none matched.
 */
export function sniffWafMarker(buf: Buffer): string | null {
  const head = buf.subarray(0, Math.min(buf.length, WAF_SNIFF_BYTES))
    .toString('utf8')
    .toLowerCase();
  for (const m of HTML_MARKERS) {
    if (head.includes(m)) return m;
  }
  return null;
}

/**
 * Guard an already-buffered body against WAF / captcha / maintenance
 * HTML. Throws with URL + matched marker (or ZIP-magic mismatch) on
 * a hit.
 *
 * Use this directly when the caller has the bytes in hand (e.g.
 * reading from disk, in-memory pipeline). For HTTP responses use
 * {@link assertNotWafResponse} which buffers first and returns the
 * validated buf.
 */
export function assertNotWafBuffer(
  buf: Buffer,
  url: string,
  expected: ExpectedKind,
): GuardOk {
  if (looksLikeHtml(/* content-type not in scope here */ null)) {
    // Defensive - this branch is unreachable from this entry point
    // (no Content-Type available for an arbitrary buffer). Kept for
    // symmetry with assertNotWafResponse.
    throw new Error(`GET ${url}: looks like HTML body`);
  }

  const marker = sniffWafMarker(buf);
  if (marker !== null) {
    throw new Error(
      `GET ${url}: upstream body contains "${marker}" marker - ` +
      `looks like a WAF / captcha page. Aborting to avoid shipping poisoned output.`,
    );
  }

  if (expected === 'zip') {
    if (buf.length < 4 || !buf.subarray(0, 4).equals(ZIP_MAGIC)) {
      const preview = buf.subarray(0, Math.min(buf.length, MAGIC_PREVIEW_BYTES))
        .toString('utf8')
        .replace(/[\x00-\x1f\x7f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      throw new Error(
        `GET ${url}: upstream body is not a ZIP file ` +
        `(first bytes: "${preview.slice(0, MAGIC_PREVIEW_BYTES)}") - ` +
        `aborting to avoid shipping poisoned output.`,
      );
    }
  }

  return { buf };
}

/**
 * Buffer the response body and validate it isn't a WAF / captcha
 * page. Returns the buffered body so the caller doesn't re-read.
 *
 * Three layers (see module header): Content-Type, body-marker sniff,
 * and (for `expected: 'zip'`) ZIP-magic verification.
 */
export async function assertNotWafResponse(
  res: Response,
  url: string,
  expected: ExpectedKind,
): Promise<GuardOk> {
  // Cheap path: Content-Type advertises HTML when it shouldn't.
  if (looksLikeHtml(res.headers.get('content-type'))) {
    throw new Error(
      `GET ${url}: upstream returned HTML body ` +
      `(content-type=${res.headers.get('content-type') ?? '<none>'}) - ` +
      `looks like a WAF / captcha page. Aborting to avoid shipping poisoned output.`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return assertNotWafBuffer(buf, url, expected);
}