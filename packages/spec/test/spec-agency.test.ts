import { describe, it, expect } from 'vitest';
import { AgencyRowSchema, parseAgency } from '../src/spec/agency.js';

describe('parseAgency', () => {
  it('parses a minimal valid agency.txt', async () => {
    const csv = [
      'agency_name,agency_url,agency_timezone',
      'CTP Cluj-Napoca,https://www.ctpcluj.ro/,Europe/Bucharest',
    ].join('\n');
    const rows = await parseAgency(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agency_name).toBe('CTP Cluj-Napoca');
    expect(rows[0]?.agency_url).toBe('https://www.ctpcluj.ro/');
    expect(rows[0]?.agency_timezone).toBe('Europe/Bucharest');
  });

  it('strips the UTF-8 BOM', async () => {
    const csv = '\uFEFFagency_name,agency_url,agency_timezone\nCTP,https://ctp.ro/,Europe/Bucharest';
    expect(await parseAgency(csv)).toHaveLength(1);
  });

  it('rejects a row with empty agency_name', async () => {
    const csv = 'agency_name,agency_url,agency_timezone\n,https://ctp.ro/,Europe/Bucharest';
    await expect(parseAgency(csv)).rejects.toThrow();
  });

  it('returns an empty array for header-only input', async () => {
    const csv = 'agency_name,agency_url,agency_timezone';
    expect(await parseAgency(csv)).toEqual([]);
  });
});

describe('AgencyRowSchema', () => {
  it('accepts a fully populated row', () => {
    const row = AgencyRowSchema.parse({
      agency_id: 'ctp',
      agency_name: 'CTP',
      agency_url: 'https://www.ctpcluj.ro/',
      agency_timezone: 'Europe/Bucharest',
      agency_lang: 'ro',
      agency_phone: '+40 264 123 456',
      agency_fare_url: 'https://www.ctpcluj.ro/tickets',
      agency_email: 'contact@ctpcluj.ro',
    });
    expect(row.agency_lang).toBe('ro');
  });
});