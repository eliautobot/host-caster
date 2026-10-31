import { describe, expect, it } from 'vitest';
import { isWebUrl } from './links';

describe('isWebUrl', () => {
  it('lets only http(s) pages through (a restored station homepage can be anything)', () => {
    expect(isWebUrl('https://radio.example.com/')).toBe(true);
    expect(isWebUrl('http://radio.example.com')).toBe(true);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'hostcaster://auth?code=x', '//evil.example', '']) {
      expect(isWebUrl(bad), bad).toBe(false);
    }
  });
});
