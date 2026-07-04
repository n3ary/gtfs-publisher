import { describe, it, expect } from 'vitest';
import { parseFeedInfo } from '../src/spec/feed_info.js';

describe('parseFeedInfo', () => {
  it('parses feed-level metadata', async () => {
    const csv = [
      'feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version',
      'CTP,https://www.ctpcluj.ro/,ro,20260101,20261231,2026-07-01T00:00:00Z',
    ].join('\n');
    const rows = await parseFeedInfo(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.feed_publisher_name).toBe('CTP');
    expect(rows[0]?.feed_start_date).toBe('20260101');
  });

  it('rejects a malformed contact_email', async () => {
    const csv = 'feed_publisher_name,feed_publisher_url,feed_lang,feed_contact_email\nCTP,https://ctp.ro/,ro,not-an-email';
    await expect(parseFeedInfo(csv)).rejects.toThrow();
  });
});