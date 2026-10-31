// Text helpers shared by search, grouping, duplicate detection and playlist matching.

/** lowercase, no accents, punctuation folded to spaces, single spaces */
export function norm(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** 53-bit string/byte hash (cyrb53) as hex. Works without crypto.subtle (plain http on a LAN). */
export function hash53(input: string | Uint8Array, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const n = input.length;
  for (let i = 0; i < n; i++) {
    const ch = typeof input === 'string' ? input.charCodeAt(i) : input[i]!;
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** '/music/Album/01 Song.mp3' -> '01 Song.mp3' (handles Windows paths and file:// URLs) */
export function baseName(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/[?#].*$/, '');
  return clean.slice(clean.lastIndexOf('/') + 1);
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** '03 - Late Train' / '03. Late Train' / '1-03 Late Train' -> 'Late Train' */
export function titleFromFileName(name: string): string {
  const stem = stripExt(baseName(name)).replace(/_/g, ' ');
  const t = stem.replace(/^\s*(\d{1,2}[-.])?\d{1,3}(\s*[-.)]\s*|\s+)(?=\S)/, '').trim();
  return t || stem.trim();
}

/** 'Artist - Title' -> { artist, title }; no separator -> { title } */
export function splitArtistTitle(s: string): { artist?: string; title: string } {
  const i = s.indexOf(' - ');
  if (i <= 0) return { title: s.trim() };
  return { artist: s.slice(0, i).trim(), title: s.slice(i + 3).trim() };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i < 2 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** '1 hr 12 min' / '42 min' for list headers */
export function formatTotal(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${Math.max(min, ms > 0 ? 1 : 0)} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
