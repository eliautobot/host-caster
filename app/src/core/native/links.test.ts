import { describe, expect, it, vi } from 'vitest';
import { isWebUrl, onForeground } from './links';

describe('isWebUrl', () => {
  it('lets only http(s) pages through (a restored station homepage can be anything)', () => {
    expect(isWebUrl('https://radio.example.com/')).toBe(true);
    expect(isWebUrl('http://radio.example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'hostcaster://auth?code=x', '//evil.example', '']) {
      expect(isWebUrl(bad), bad).toBe(false);
    }
  });
});

describe('onForeground', () => {
  it('fires when the page becomes visible again, once per return, and stops when removed', () => {
    // (tests run without a DOM: a stand-in document)
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' as string });
    vi.stubGlobal('document', doc);
    let seen = 0;
    const off = onForeground(() => seen++);
    const show = (state: 'visible' | 'hidden') => {
      doc.visibilityState = state;
      doc.dispatchEvent(new Event('visibilitychange'));
    };
    show('hidden');
    expect(seen).toBe(0);
    show('visible');
    show('visible');
    expect(seen).toBe(1);
    off();
    show('visible');
    expect(seen).toBe(1);
    vi.unstubAllGlobals();
  });
});
