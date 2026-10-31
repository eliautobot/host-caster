// radio-browser.info: a free, community-run directory of ~50k internet radio stations (no key).
// Browsers cannot do the DNS lookup the API docs suggest, so we read the server list from
// all.api.radio-browser.info/json/servers, pick one at random, and fail over to the others.
import { kvGet, kvSet } from '../../db';

export interface RadioStation {
  uuid: string;
  name: string;
  /** playable URL (url_resolved when the directory resolved a playlist) */
  url: string;
  homepage?: string;
  favicon?: string;
  tags: string[];
  country?: string;
  countryCode?: string;
  state?: string;
  language?: string;
  codec?: string;
  /** kbps; 0 = unknown */
  bitrate: number;
  hls: boolean;
  votes: number;
  clicks: number;
  /** last directory check succeeded */
  ok: boolean;
}

/** Raw shape from the API (subset). */
export interface RawStation {
  stationuuid?: string;
  name?: string;
  url?: string;
  url_resolved?: string;
  homepage?: string;
  favicon?: string;
  tags?: string;
  country?: string;
  countrycode?: string;
  state?: string;
  language?: string;
  codec?: string;
  bitrate?: number;
  hls?: number;
  votes?: number;
  clickcount?: number;
  lastcheckok?: number;
}

export interface RadioTag {
  name: string;
  stations: number;
}

export interface RadioCountry {
  code: string;
  name: string;
  stations: number;
}

const DISCOVERY_URL = 'https://all.api.radio-browser.info/json/servers';
/** used when discovery itself is down */
const FALLBACK_SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info'];
const SERVERS_KEY = 'radiobrowser:servers';
const SERVERS_TTL = 24 * 3600_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function cleanUrl(s: string | undefined): string | undefined {
  const v = clean(s);
  return /^https?:\/\//i.test(v) ? v : undefined;
}

/** Normalizes API rows: trims, splits tags, drops rows without a usable URL, dedupes by uuid. */
export function parseStations(rows: RawStation[]): RadioStation[] {
  const seen = new Set<string>();
  const out: RadioStation[] = [];
  for (const r of rows) {
    const url = cleanUrl(r.url_resolved) ?? cleanUrl(r.url);
    const uuid = clean(r.stationuuid);
    const name = clean(r.name);
    if (!url || !uuid || !name || seen.has(uuid)) continue;
    seen.add(uuid);
    const tags = [
      ...new Set(
        clean(r.tags)
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t && t.length <= 32),
      ),
    ];
    out.push({
      uuid,
      name,
      url,
      homepage: cleanUrl(r.homepage),
      favicon: cleanUrl(r.favicon),
      tags,
      country: clean(r.country) || undefined,
      countryCode: clean(r.countrycode).toUpperCase() || undefined,
      state: clean(r.state) || undefined,
      language: clean(r.language) || undefined,
      codec: clean(r.codec).toUpperCase() || undefined,
      bitrate: Math.max(0, Number(r.bitrate) || 0),
      hls: Number(r.hls) === 1,
      votes: Math.max(0, Number(r.votes) || 0),
      clicks: Math.max(0, Number(r.clickcount) || 0),
      ok: r.lastcheckok === undefined ? true : Number(r.lastcheckok) === 1,
    });
  }
  return out;
}

let regionNames: Intl.DisplayNames | undefined;
/** Short, localized country name from the ISO code ("GB" -> "United Kingdom"); the directory's names are long. */
export function countryName(code: string | undefined, fallback?: string): string | undefined {
  if (code && /^[A-Z]{2}$/.test(code)) {
    try {
      regionNames ??= new Intl.DisplayNames([typeof navigator !== 'undefined' ? navigator.language : 'en', 'en'], { type: 'region' });
      const n = regionNames.of(code);
      if (n && n !== code) return n;
    } catch {
      // old engines: fall back
    }
  }
  return fallback;
}

/** Genres that make good chips (the directory's own top tags are noisy: "music", "fm", city names ...). */
export const RADIO_GENRES = [
  'pop', 'rock', 'jazz', 'classical', 'news', 'talk', 'dance', 'electronic', 'hiphop', 'chillout', 'ambient',
  'lounge', 'oldies', '80s', '90s', 'country', 'blues', 'soul', 'funk', 'reggae', 'latin', 'metal', 'indie', 'folk',
  'house', 'techno', 'sports', 'kids',
];

/** One line for lists: "France · AAC 64 kbps" */
export function stationMeta(st: RadioStation): string {
  const parts: string[] = [];
  const country = countryName(st.countryCode, st.country);
  if (country) parts.push(st.state && st.state !== country && st.state !== st.country ? `${st.state}, ${country}` : country);
  const fmt = [st.codec && st.codec !== 'UNKNOWN' ? st.codec : '', st.bitrate ? `${st.bitrate} kbps` : '']
    .filter(Boolean)
    .join(' ');
  if (fmt) parts.push(fmt);
  return parts.join(' · ');
}

/** Will this play in this context? https pages cannot load http streams (mixed content). */
export function playableHere(st: RadioStation, pageProtocol = typeof location !== 'undefined' ? location.protocol : 'http:') {
  if (pageProtocol === 'https:' && st.url.startsWith('http:')) return false;
  return true;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class RadioBrowser {
  private servers: string[] | undefined;

  constructor(
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private opts: { cache?: boolean; timeoutMs?: number } = {},
  ) {}

  /** Server host names, random order (spreads load as the API asks). */
  async discover(): Promise<string[]> {
    if (this.servers) return this.servers;
    const useCache = this.opts.cache !== false;
    if (useCache) {
      const cached = await kvGet<string[]>(SERVERS_KEY).catch(() => undefined);
      if (cached && Date.now() - cached.fetchedAt < SERVERS_TTL && cached.value.length) {
        return (this.servers = shuffle(cached.value));
      }
    }
    try {
      const res = await this.fetchImpl(DISCOVERY_URL, { signal: AbortSignal.timeout(6000) });
      const list = (await res.json()) as { name?: string }[];
      const names = [...new Set(list.map((s) => clean(s.name)).filter((n) => n.endsWith('.radio-browser.info')))];
      if (names.length) {
        if (useCache) await kvSet(SERVERS_KEY, names).catch(() => undefined);
        return (this.servers = shuffle(names));
      }
    } catch {
      // fall through
    }
    return (this.servers = shuffle(FALLBACK_SERVERS));
  }

  /** GET /json/<path> with failover across servers. */
  async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
    const qs = q.toString();
    const servers = await this.discover();
    let lastErr: unknown;
    for (const host of servers) {
      try {
        const res = await this.fetchImpl(`https://${host}/json/${path}${qs ? `?${qs}` : ''}`, {
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10000),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`radio-browser ${res.status}`);
        return (await res.json()) as T;
      } catch (err) {
        lastErr = err;
        // move this server to the back for next time
        this.servers = [...servers.filter((s) => s !== host), host];
      }
    }
    throw new Error(`The radio directory is not reachable right now (${String((lastErr as Error)?.message ?? lastErr)})`);
  }

  async search(opts: {
    name?: string;
    tag?: string;
    countryCode?: string;
    language?: string;
    limit?: number;
    offset?: number;
    order?: 'clickcount' | 'votes' | 'name' | 'bitrate' | 'random';
  }): Promise<RadioStation[]> {
    const rows = await this.get<RawStation[]>('stations/search', {
      name: opts.name?.trim(),
      tag: opts.tag?.trim().toLowerCase(),
      tagExact: opts.tag ? true : undefined,
      countrycode: opts.countryCode?.trim().toUpperCase(),
      language: opts.language?.trim().toLowerCase(),
      limit: opts.limit ?? 40,
      offset: opts.offset ?? 0,
      order: opts.order ?? 'clickcount',
      reverse: opts.order === 'name' ? false : true,
      hidebroken: true,
    });
    return parseStations(rows);
  }

  async popular(limit = 40): Promise<RadioStation[]> {
    return parseStations(await this.get<RawStation[]>(`stations/topclick/${limit}`, { hidebroken: true }));
  }

  async topVoted(limit = 40): Promise<RadioStation[]> {
    return parseStations(await this.get<RawStation[]>(`stations/topvote/${limit}`, { hidebroken: true }));
  }

  async byUuid(uuid: string): Promise<RadioStation | undefined> {
    return (await this.byUuids([uuid]))[0];
  }

  /** Many stations in one request (the API takes a comma list), in the order asked. */
  async byUuids(uuids: string[]): Promise<RadioStation[]> {
    const ids = [...new Set(uuids.map((u) => u.trim()).filter(Boolean))].slice(0, 100);
    if (!ids.length) return [];
    const found = parseStations(await this.get<RawStation[]>('stations/byuuid', { uuids: ids.join(',') }));
    const byId = new Map(found.map((st) => [st.uuid, st]));
    return ids.map((id) => byId.get(id)).filter((st): st is RadioStation => Boolean(st));
  }

  async tags(limit = 40): Promise<RadioTag[]> {
    const rows = await this.get<{ name?: string; stationcount?: number }[]>('tags', {
      order: 'stationcount',
      reverse: true,
      hidebroken: true,
      limit: limit * 2,
    });
    return rows
      .map((r) => ({ name: clean(r.name).toLowerCase(), stations: Number(r.stationcount) || 0 }))
      .filter((t) => t.name && t.name.length <= 24 && !/^\d+$/.test(t.name))
      .slice(0, limit);
  }

  async countries(): Promise<RadioCountry[]> {
    const rows = await this.get<{ name?: string; iso_3166_1?: string; stationcount?: number }[]>('countries', {
      order: 'stationcount',
      reverse: true,
      hidebroken: true,
    });
    return rows
      .map((r) => ({ code: clean(r.iso_3166_1).toUpperCase(), name: clean(r.name), stations: Number(r.stationcount) || 0 }))
      .filter((c) => /^[A-Z]{2}$/.test(c.code) && c.name);
  }

  /** Counts a play (the API asks clients to do this when a station starts). Best effort. */
  async countClick(uuid: string): Promise<void> {
    await this.get(`url/${encodeURIComponent(uuid)}`).catch(() => undefined);
  }
}

export const radioBrowser = new RadioBrowser();
