// A web page as readable text for the hosts: title, site, description and the article's paragraphs (menus, scripts,
// footers, forms and cookie banners left out), capped. Plain regex work: pages are untrusted and only read, never run.
import { capText, decodeEntities } from '../integrations/details.js';

const DROP = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template|button|select|figure)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK = /<(p|h[1-4]|li|blockquote|pre|td|dd)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const NOISE = /cookie|subscribe|sign up|newsletter|advertis|all rights reserved|javascript|enable js|privacy policy|terms of (use|service)|share this|follow us|read more:|related:|click here/i;

const strip = (html) => decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function meta(html, name) {
  const re = new RegExp(`<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name}["'][^>]*>`, 'i');
  const tag = re.exec(html)?.[0];
  const content = tag && /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? strip(content) : undefined;
}

/** The part of the page most likely to be the article: <article>, else <main>, else the body. */
function mainPart(html) {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)].map((m) => m[1]);
  if (articles.length) return articles.sort((a, b) => b.length - a.length)[0];
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html)?.[1];
  if (main) return main;
  return /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(html)?.[1] ?? html;
}

/**
 * @param {string} body the page
 * @param {string} [contentType]
 * @param {number} [max] characters of text
 * @returns {{ title?: string, site?: string, description?: string, text: string }}
 */
export function readablePage(body, contentType = 'text/html', max = 3500) {
  const type = String(contentType).split(';')[0].trim().toLowerCase();
  if (type === 'text/plain' || type === 'text/markdown') return { text: capText(String(body).replace(/\s+\n/g, '\n').trim(), max) };
  if (type.includes('json')) return { text: capText(String(body).trim(), Math.min(max, 1500)) };
  const html = String(body);
  const title = meta(html, 'og:title') ?? (strip(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? '') || undefined);
  const site = meta(html, 'og:site_name');
  const description = meta(html, 'og:description') ?? meta(html, 'description');
  const part = mainPart(html.replace(/<!--[\s\S]*?-->/g, ' ')).replace(DROP, ' ');
  const seen = new Set();
  const lines = [];
  let size = 0;
  for (const m of part.matchAll(BLOCK)) {
    const line = strip(m[2]);
    const heading = /^h/i.test(m[1]);
    if (line.length < (heading ? 4 : 40) || NOISE.test(line) && line.length < 200 || seen.has(line)) continue;
    seen.add(line);
    lines.push(m[1].toLowerCase() === 'li' ? `- ${line}` : line);
    size += line.length;
    if (size > max * 1.5) break;
  }
  let text = lines.join('\n');
  if (!text) text = strip(part).slice(0, max * 2);
  return {
    ...(title ? { title: capText(title, 200) } : {}),
    ...(site ? { site: capText(site, 80) } : {}),
    ...(description ? { description: capText(description, 300) } : {}),
    text: capText(text, max),
  };
}
