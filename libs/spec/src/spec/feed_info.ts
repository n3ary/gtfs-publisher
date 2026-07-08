/**
 * GTFS feed_info.txt reader.
 * https://gtfs.org/documentation/schedule/reference/#feed_infotxt
 *
 * Feed-level metadata: publisher, language, version, validity window.
 */

import { z } from 'zod';
import { parseRows, parseRowsStream } from '../helper/csv-parse.js';

export const FeedInfoRowSchema = z.object({
  /** Required. Full name of the organization that publishes the feed. */
  feed_publisher_name: z.string().min(1),
  /** Required. URL of the publisher's website. */
  feed_publisher_url: z.string().min(1),
  /** Required. Default language for text in this feed. */
  feed_lang: z.string().min(1),
  /** Optional. Feed start date (YYYYMMDD). */
  feed_start_date: z.string().optional(),
  /** Optional. Feed end date (YYYYMMDD). */
  feed_end_date: z.string().optional(),
  /** Optional. Version string of this feed publication. */
  feed_version: z.string().optional(),
  /** Optional. Contact email for feed issues. */
  feed_contact_email: z.string().email().optional(),
  /** Optional. Contact URL for feed issues. */
  feed_contact_url: z.string().optional(),
}).passthrough();

export type FeedInfoRow = z.infer<typeof FeedInfoRowSchema>;

export const parseFeedInfo = (text: string): Promise<FeedInfoRow[]> => parseRows(FeedInfoRowSchema, text);
export const parseFeedInfoStream = (source: AsyncIterable<string>): AsyncIterable<FeedInfoRow> =>
  parseRowsStream(FeedInfoRowSchema, source);