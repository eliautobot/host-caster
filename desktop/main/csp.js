// The Content-Security-Policy of the app's index.html (no Electron imports, so it can be unit tested).
import { createHash } from 'node:crypto';

/**
 * Hashes of the inline scripts in a page. The HTML parser turns CRLF and lone CR into LF before the browser hashes a
 * script, so the text is normalized the same way first: a Windows checkout (CRLF) otherwise gets a hash that never
 * matches and the inline theme script is blocked.
 */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const text = m[1].replace(/\r\n?/g, '\n');
    out.push(`'sha256-${createHash('sha256').update(text).digest('base64')}'`);
  }
  return out;
}

/** Scripts only from the app itself, its own inline theme script, and the YouTube / Spotify players it embeds. */
export function contentSecurityPolicy(html) {
  return [
    `script-src 'self' ${inlineScriptHashes(html).join(' ')} https://www.youtube.com https://s.ytimg.com https://sdk.scdn.co`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}
