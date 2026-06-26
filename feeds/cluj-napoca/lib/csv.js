/**
 * Tiny streaming CSV reader for GTFS .txt files extracted from the seed zip.
 *
 * GTFS rules we honour:
 *   - First non-empty line is the header
 *   - Comma-separated; double-quote escaped fields support embedded commas
 *   - Lines may end with \n or \r\n
 *
 * Not honoured (don't appear in real GTFS):
 *   - Multi-line quoted fields
 *
 * Returns rows as plain objects keyed by header name.
 */

export function parseGtfsCsv(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];

  // Skip BOM + leading empty lines
  let i = 0;
  while (i < lines.length && lines[i].trim().length === 0) i++;
  if (i === lines.length) return [];
  if (lines[i].charCodeAt(0) === 0xfeff) lines[i] = lines[i].slice(1);

  const header = splitCsvLine(lines[i]);
  const out = [];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].length === 0) continue;
    const cols = splitCsvLine(lines[j]);
    const row = {};
    for (let k = 0; k < header.length; k++) row[header[k]] = cols[k] ?? '';
    out.push(row);
  }
  return out;
}

function splitCsvLine(line) {
  const out = [];
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
