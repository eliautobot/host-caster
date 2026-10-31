// RSS 2.0 / Atom / RDF headlines. Regex based so it runs anywhere (no DOMParser in workers or tests).
import type { Headline } from '../types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

function tag(block: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decodeEntities(m[1]!).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : undefined;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Parses a feed; `fallbackSource` names the feed when it has no title. */
export function parseFeed(xml: string, fallbackSource = 'News'): Headline[] {
  const channel = /<channel[\s\S]*?(?=<item[\s>])/i.exec(xml)?.[0] ?? /<feed[\s\S]*?(?=<entry[\s>])/i.exec(xml)?.[0] ?? '';
  const source = (channel && tag(channel, 'title')) || fallbackSource;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/(item|entry)>/gi) ?? [];
  const out: Headline[] = [];
  for (const b of blocks) {
    const title = tag(b, 'title');
    if (!title) continue;
    const link = tag(b, 'link') || /<link[^>]*href="([^"]+)"/i.exec(b)?.[1];
    const date = tag(b, 'pubDate') ?? tag(b, 'published') ?? tag(b, 'updated') ?? tag(b, 'dc:date');
    const at = date ? Date.parse(date) : NaN;
    out.push({ id: `news:${hash(link || title)}`, title, source, url: link || undefined, at: Number.isFinite(at) ? at : undefined });
  }
  return out;
}
