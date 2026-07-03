import { describe, it, expect } from 'vitest';
import { LicenseSchema } from '../src/schema/license.js';

describe('LicenseSchema', () => {
  it('accepts a minimal attribution-only license', () => {
    const result = LicenseSchema.parse({
      spdx_identifier: null,
      attribution_text: '© CTP',
      attribution_url: null,
    });
    expect(result.attribution_text).toBe('© CTP');
  });

  it('accepts a fully populated SPDX license', () => {
    const result = LicenseSchema.parse({
      spdx_identifier: 'CC-BY-4.0',
      attribution_text: '© Compania de Transport Public Cluj-Napoca',
      attribution_url: 'https://www.ctpcluj.ro/',
    });
    expect(result.spdx_identifier).toBe('CC-BY-4.0');
  });

  it('rejects an empty attribution_text', () => {
    expect(() => LicenseSchema.parse({
      spdx_identifier: null,
      attribution_text: '',
      attribution_url: null,
    })).toThrow();
  });

  it('rejects a non-URL attribution_url', () => {
    expect(() => LicenseSchema.parse({
      spdx_identifier: 'MIT',
      attribution_text: '© Acme',
      attribution_url: 'not-a-url',
    })).toThrow();
  });
});