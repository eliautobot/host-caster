// Account news: reputable public feeds by region (free to read, no paywall), so the hosts have headlines from the
// first break. The listener can pick another region or their own feeds in Settings; a station with feeds of its own
// uses those instead. Every URL here is checked live by context/feeds.check.test.ts (directly, as the phone apps fetch,
// and through the server's fetch-text route, as the web app does): HTTP 200, 5+ headlines, one from the last 3 days.
import type { Connections, GeoPlace, Station } from '../types';

export interface NewsFeed {
  name: string;
  url: string;
}

export interface NewsRegion {
  id: string;
  label: string;
  feeds: NewsFeed[];
}

export const NEWS_REGIONS: NewsRegion[] = [
  {
    id: 'us',
    label: 'United States',
    feeds: [
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
      { name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
      { name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main' },
    ],
  },
  {
    id: 'uk',
    label: 'United Kingdom',
    feeds: [
      { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
      { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/home.xml' },
      { name: 'The Guardian', url: 'https://www.theguardian.com/uk/rss' },
    ],
  },
  {
    id: 'ca',
    label: 'Canada',
    feeds: [
      { name: 'CBC News', url: 'https://www.cbc.ca/webfeed/rss/rss-topstories' },
      { name: 'Global News', url: 'https://globalnews.ca/feed/' },
    ],
  },
  {
    id: 'au',
    label: 'Australia',
    feeds: [
      // ABC's Top Stories (SBS left out: its feed had not changed since August 2026 when checked)
      { name: 'ABC News', url: 'https://www.abc.net.au/news/feed/45910/rss.xml' },
      { name: 'Guardian Australia', url: 'https://www.theguardian.com/australia-news/rss' },
    ],
  },
  {
    id: 'in',
    label: 'India',
    feeds: [
      { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
      { name: 'The Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
    ],
  },
  {
    id: 'ie',
    label: 'Ireland',
    feeds: [
      { name: 'RTÉ News', url: 'https://www.rte.ie/feeds/rss/?index=/news/' },
      { name: 'TheJournal.ie', url: 'https://www.thejournal.ie/feed/' },
    ],
  },
  {
    id: 'nz',
    label: 'New Zealand',
    feeds: [
      { name: 'RNZ News', url: 'https://www.rnz.co.nz/rss/news.xml' },
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
    ],
  },
  {
    id: 'world',
    label: 'World',
    feeds: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
      { name: 'DW News', url: 'https://rss.dw.com/rdf/rss-en-all' },
    ],
  },
];

const WORLD = NEWS_REGIONS.find((r) => r.id === 'world')!;

export function newsRegion(id: string | undefined): NewsRegion | undefined {
  return NEWS_REGIONS.find((r) => r.id === id);
}

/** The name of one of the default feeds ("NPR News"), as the hosts should say it. */
export function knownFeedName(url: string): string | undefined {
  for (const r of NEWS_REGIONS) for (const f of r.feeds) if (f.url === url) return f.name;
  return undefined;
}

/** A feed's name for the UI: a default feed's name, else its host name. */
export function feedName(url: string): string {
  const known = knownFeedName(url);
  if (known) return known;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const CA_ZONES = /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina|Moncton|Glace_Bay|Goose_Bay|Whitehorse|Dawson|Dawson_Creek|Yellowknife|Iqaluit|Rankin_Inlet|Resolute|Cambridge_Bay|Inuvik|Swift_Current|Creston|Fort_Nelson|Atikokan|Blanc-Sablon|Nipigon|Thunder_Bay|Rainy_River|Pangnirtung|Montreal)$|^Canada\//;
const US_ZONES = /^America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Adak|Boise|Detroit|Indiana\/.+|Kentucky\/.+|North_Dakota\/.+|Menominee|Metlakatla|Nome|Sitka|Yakutat|Juneau|Indianapolis|Louisville)$|^Pacific\/Honolulu$|^US\//;

/** Region from an IANA time zone, when it says clearly. */
export function regionFromTimeZone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  if (US_ZONES.test(tz)) return 'us';
  if (CA_ZONES.test(tz)) return 'ca';
  if (/^(Europe\/(London|Belfast|Guernsey|Jersey|Isle_of_Man)|GB)$/.test(tz)) return 'uk';
  if (/^(Europe\/Dublin|Eire)$/.test(tz)) return 'ie';
  if (/^Australia\//.test(tz)) return 'au';
  if (/^(Pacific\/(Auckland|Chatham)|NZ)$/.test(tz)) return 'nz';
  if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return 'in';
  return undefined;
}

/** Region from a BCP-47 locale's country part (en-GB, fr-CA, hi-IN ...). */
export function regionFromLocale(locale: string | undefined): string | undefined {
  const cc = /[-_]([A-Za-z]{2})\b/.exec(locale ?? '')?.[1]?.toUpperCase();
  const map: Record<string, string> = { US: 'us', GB: 'uk', UK: 'uk', CA: 'ca', AU: 'au', IN: 'in', IE: 'ie', NZ: 'nz' };
  return cc ? map[cc] : undefined;
}

/** Region from the place in About me, only where a coarse box is clear (borders are left to the other hints). */
export function regionFromPlace(place: Pick<GeoPlace, 'lat' | 'lon'> | undefined): string | undefined {
  if (!place) return undefined;
  const { lat, lon } = place;
  const inBox = (la1: number, la2: number, lo1: number, lo2: number) => lat >= la1 && lat <= la2 && lon >= lo1 && lon <= lo2;
  if (inBox(-44, -10, 112, 154)) return 'au';
  if (inBox(-47.5, -34, 166, 179)) return 'nz';
  if (inBox(6, 36, 68, 97.5) && !inBox(23.5, 37, 60, 75.5)) return 'in';
  if (inBox(51.3, 55.5, -10.7, -6) && !(lat > 54 && lon > -8.2)) return 'ie';
  if (inBox(49.9, 61, -8.2, 1.8) && !inBox(51.3, 55.5, -10.7, -6.3)) return 'uk';
  return undefined;
}

export interface RegionHints {
  place?: Pick<GeoPlace, 'lat' | 'lon'>;
  timeZone?: string;
  locales?: readonly string[];
}

/** This device's hints (time zone and languages); the place comes from the profile. */
export function deviceHints(): Omit<RegionHints, 'place'> {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const locales = typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  return { timeZone, locales };
}

/** The listener's region: the place they saved, then the time zone, then the language; else 'world'. */
export function guessRegion(hints: RegionHints): string {
  return regionFromPlace(hints.place) ?? regionFromTimeZone(hints.timeZone) ?? hints.locales?.map(regionFromLocale).find(Boolean) ?? 'world';
}

export interface AccountNews {
  /** news on air at all (Settings, Connections) */
  enabled: boolean;
  /** the region whose default feeds play, when the listener has no list of their own */
  region: string;
  /** true = the listener's own list */
  custom: boolean;
  feeds: string[];
}

/** An empty or missing list means the region's defaults (news is switched off with `enabled`, not by emptying it). */
export function accountNews(conn: Connections['news'], hints: RegionHints): AccountNews {
  const region = newsRegion(conn?.region)?.id ?? guessRegion(hints);
  const custom = (conn?.feeds?.length ?? 0) > 0;
  const feeds = custom ? conn!.feeds! : regionFeeds(region);
  return { enabled: conn?.enabled !== false, region, custom, feeds };
}

export function regionFeeds(region: string): string[] {
  return (newsRegion(region) ?? WORLD).feeds.map((f) => f.url);
}

/** The feeds a station's hosts read: its own list, else the account's. */
export function stationFeeds(station: Pick<Station, 'newsFeeds'>, account: AccountNews): string[] {
  return station.newsFeeds?.length ? station.newsFeeds : account.feeds;
}
