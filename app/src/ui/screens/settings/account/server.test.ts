import { describe, expect, it } from 'vitest';
import { DEFAULT_NATIVE_SERVER, defaultServerUrl, normalizeServerUrl } from './server';

describe('normalizeServerUrl', () => {
  it('keeps https and private-network http, refuses plain http to the internet (token and keys in clear)', () => {
    expect(normalizeServerUrl('radio.example.com')).toBe('https://radio.example.com');
    expect(normalizeServerUrl('192.168.1.20:8660')).toBe('http://192.168.1.20:8660');
    for (const ok of ['http://localhost:8660', 'http://10.0.0.5:8660', 'http://100.90.10.20:8660', 'http://my-server:8660', 'http://radio.local:8660', 'http://box.tail1234.ts.net', 'http://[::1]:8660']) {
      expect(normalizeServerUrl(ok), ok).toBe(ok);
    }
    for (const bad of ['http://radio.example.com', 'http://203.0.113.9:8660', 'http://8.8.8.8']) {
      expect(() => normalizeServerUrl(bad), bad).toThrow(/https/);
    }
  });
});

describe('default server', () => {
  it('phone apps default to the hosted service; the web app to its own server', () => {
    expect(DEFAULT_NATIVE_SERVER).toBe('https://app.host-caster.com');
    expect(normalizeServerUrl(DEFAULT_NATIVE_SERVER)).toBe(DEFAULT_NATIVE_SERVER);
    expect(defaultServerUrl()).toBe('');
  });
});
