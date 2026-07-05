/**
 * Shared HTTP helpers - single User-Agent + WAF body guard.
 *
 * The WAF guard lives in @n3ary/gtfs-spec/waf so every consumer
 * (publisher + every feed adapter) shares one implementation. See
 * the module header in packages/spec/src/waf/index.ts for the
 * detection policy + rationale.
 *
 * History: previously had a local copy of the WAF body guard in
 * this file. Centralised so a new WAF fingerprint only needs
 * adding in one place - and so the publisher and every adapter
 * can't drift on what counts as "looks like a WAF".
 */

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertNotWafResponse } from '@n3ary/gtfs-spec/waf';

export const UA = 'gtfs/2.0 (https://github.com/n3ary/gtfs-publisher)';

export async function fetchJson(url: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, ...extraHeaders } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  // Guard catches the 200+HTML / 200+error-JSON cases that
  // res.json() would otherwise either parse as data or fail with
  // a generic SyntaxError. Adds URL + marker context.
  const { buf } = await assertNotWafResponse(res, url, 'json');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`GET ${url}: response body is not valid JSON: ${(e as Error).message}`);
  }
}

export async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

export async function fetchToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`GET ${url}: HTTP ${res.status}`);
  // Buffer the body in memory so we can sniff for WAF HTML /
  // captcha pages BEFORE writing to disk. fetchToFile is used for
  // .gtfs.zip downloads (Transitous + remote sources). A Cloudflare
  // challenge page returned with HTTP 200 used to be written to
  // disk as a zip file - either failing unzip loudly downstream or
  // parsing as garbage rows. Either way the published SQLite ended
  // up poisoned.
  const { buf } = await assertNotWafResponse(res, url, 'zip');
  await pipeline(Readable.from(buf), createWriteStream(dest));
}