// The index.html Content-Security-Policy: inline script hashes match what the browser hashes, on any line endings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contentSecurityPolicy, inlineScriptHashes } from '../main/csp.js';

const sha = (text) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;
const page = '<html><head>\n<script>\n  var a = 1;\n  var b = 2;\n</script>\n<script type="module" src="/assets/x.js"></script>\n</head></html>\n';

test('hashes inline scripts only, not scripts with src', () => {
  assert.deepEqual(inlineScriptHashes(page), [sha('\n  var a = 1;\n  var b = 2;\n')]);
});

test('a CRLF (Windows checkout) or CR page gets the same hash as the LF page, like the HTML parser', () => {
  const lf = inlineScriptHashes(page);
  assert.deepEqual(inlineScriptHashes(page.replace(/\n/g, '\r\n')), lf);
  assert.deepEqual(inlineScriptHashes(page.replace(/\n/g, '\r')), lf);
});

test('the policy allows the app, its theme script and the embedded players, nothing inline else', () => {
  const csp = contentSecurityPolicy(page);
  assert.match(csp, /^script-src 'self' 'sha256-[A-Za-z0-9+/=]+' https:\/\/www\.youtube\.com https:\/\/s\.ytimg\.com https:\/\/sdk\.scdn\.co;/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("the app's real index.html has exactly one inline script and it is hashed", () => {
  const html = readFileSync(new URL('../../app/index.html', import.meta.url), 'utf8');
  assert.equal(inlineScriptHashes(html).length, 1);
});
