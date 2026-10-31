// Song requests: "play Dreams by Fleetwood Mac" in a call-in, or request_song from an AI app (MCP inbox). The radio
// finds the song in the station's queue or the library and plays it next; the hosts confirm it, or say kindly that
// it is not in the listener's music. Matching is by words, so "can you play some fleetwood mac" also works.
import { getInbox, markInboxUsed } from '../context/sources';
import { getSettings, listTracks } from '../db';
import { player } from '../player';
import type { Track, TrackSummary } from '../types';

export interface SongRequest {
  /** what the listener asked for, cleaned up */
  query: string;
  /** the song that plays next because of it; undefined = not found */
  found?: TrackSummary;
}

const INTENT = /\b(play|put on|spin|queue( up)?|request|hear|blast|throw on)\b/i;
const FILLER =
  /\b(can|could|would|will|you|please|pls|me|us|some|something|a little|little|bit|of|the song|song|track|tune|by the|next|now|for me|for us|right|after this|i want to|i'd like to|i would like to|love to|let's|lets|hear|play|put on|spin|queue up|queue|request|blast|throw on|again|one more time|maybe|just)\b/gi;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const MOOD = /^(?:(?:more|an?|something|some|really|very|super|kinda|bit)\s+)*(upbeat|chill|chilled|calm|relaxing|relaxed|happy|sad|slow|fast|energetic|mellow|party|dance|dancey|loud|quiet|soft|groovy|funky|romantic|moody|fun|different|else|new|good|nice|old|older|classic|random|anything|whatever|music|songs?|tunes?)(\s+(music|songs?|tunes?|stuff|one|ones|vibes?))?$/;

/** A mood ("something upbeat") rather than a song: nothing to look up. */
export function isMood(query: string): boolean {
  return !query || MOOD.test(query);
}

/** True when the text asks for music ("play ...", "can we hear ..."). */
export function isSongRequest(text: string): boolean {
  return INTENT.test(text);
}

/** The words that name the song or artist: "Could you play Dreams by Fleetwood Mac next?" -> "dreams by fleetwood mac". */
export function requestQuery(text: string): string {
  const m = INTENT.exec(text);
  const after = m ? text.slice(m.index + m[0].length) : text;
  return norm(after.replace(FILLER, ' ').replace(/[?!.]+/g, ' ')).replace(/^(by|from)\s+/, '');
}

function words(s: string): string[] {
  return norm(s).split(' ').filter((w) => w.length > 1 || /\d/.test(w));
}

/**
 * Best match for a request among `tracks` (streams excluded). Title + artist beats title alone beats artist alone.
 * `avoidId` (the song playing now) is only picked when nothing else matches.
 */
export function matchRequest(query: string, tracks: Track[], avoidId?: string): Track | undefined {
  const q = ` ${norm(query)} `;
  const qWords = new Set(words(query));
  if (!qWords.size) return undefined;
  let best: { t: Track; score: number } | undefined;
  for (const t of tracks) {
    if (t.source === 'stream') continue;
    const title = norm(t.title);
    const artist = norm(t.artist);
    let score = 0;
    if (title.length >= 2 && q.includes(` ${title} `)) score += 10 + title.length / 10;
    else {
      // most of the title's words are in the request ("bohemian rhapsody please")
      const tw = words(t.title);
      const hit = tw.filter((w) => qWords.has(w)).length;
      if (tw.length && hit / tw.length >= 0.75 && hit >= Math.min(2, tw.length)) score += 6 + hit;
    }
    if (artist.length >= 2 && q.includes(` ${artist} `)) score += 5;
    if (!score) continue;
    if (t.id === avoidId) score -= 4;
    // a little variety when only the artist matched
    score += (t.playCount ? 0 : 0.5) + Math.random() * 0.4;
    if (!best || score > best.score) best = { t, score };
  }
  return best && best.score >= 5 ? best.t : undefined;
}

export function summary(t: Track): TrackSummary {
  return { id: t.id, title: t.title, artist: t.artist, album: t.album, durationMs: t.durationMs, source: t.source };
}

/** Finds `query` in the station's queue or the library and plays it next. */
export async function queueRequest(query: string, currentId?: string): Promise<SongRequest> {
  const pool = [...player.state.queue, ...(await listTracks())];
  const track = matchRequest(query, pool, currentId);
  if (!track) return { query };
  await player.playNext([track]);
  return { query, found: summary(track) };
}

/** The oldest song request an AI app sent (request_song over MCP), queued next; marked used either way. */
export async function nextInboxRequest(currentId?: string): Promise<SongRequest | undefined> {
  const settings = await getSettings();
  const item = (await getInbox(settings.connections.aiApps?.enabled !== false)).find((i) => i.kind === 'song_request');
  if (!item) return undefined;
  await markInboxUsed([item.id]);
  const query = requestQuery(`play ${item.text}`) || norm(item.text);
  const r = await queueRequest(query, currentId);
  return r.found ? r : { query: item.text };
}
