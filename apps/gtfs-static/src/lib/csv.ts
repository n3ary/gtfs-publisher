/**
 * Tiny GTFS-CSV parser. Shared by derive-bbox.ts and the feed seed loaders.
 *
 * GTFS we honour:
 *   - First non-empty line is the header
 *   - Comma-separated; double-quote escaped fields support embedded commas
 *   - Lines may end with \n or \r\n
 *   - UTF-8 BOM on the first line is stripped
 *
 * Not honoured (don't appear in real GTFS):
 *   - Multi-line quoted fields
 */

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) { i++; continue; }
    break;
  }
  if (i >= lines.length) return [];
  const firstLine = lines[i]!;
  if (firstLine.charCodeAt(0) === 0xfeff) lines[i] = firstLine.slice(1);

  const header = splitLine(lines[i]!);
  const out: CsvRow[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    const rawLine = lines[j];
    if (rawLine === undefined || rawLine.length === 0) continue;
    const cols = splitLine(rawLine);
    const row: CsvRow = {};
    for (let k = 0; k < header.length; k++) row[header[k]!] = cols[k] ?? '';
    out.push(row);
  }
  return out;
}

function splitLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}