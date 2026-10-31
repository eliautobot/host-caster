// Response shapes from the Spotify Web API reference (trimmed). Used by spotify.test.ts only.
// Development Mode (Feb 2026): playlist `items` + row `item`; Extended Quota / classic: `tracks` + row `track`.

const album = (id: string, name: string) => ({
  album_type: 'album',
  id,
  name,
  release_date: '2019-06-14',
  release_date_precision: 'day',
  images: [
    { url: `https://i.scdn.co/image/${id}-640`, width: 640, height: 640 },
    { url: `https://i.scdn.co/image/${id}-300`, width: 300, height: 300 },
    { url: `https://i.scdn.co/image/${id}-64`, width: 64, height: 64 },
  ],
  artists: [{ id: 'ar1', name: 'Tycho', type: 'artist', uri: 'spotify:artist:ar1' }],
  uri: `spotify:album:${id}`,
});

export const trackA = {
  id: '4uLU6hMCjMI75M1A2tKUQC',
  uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC',
  name: 'Awake',
  type: 'track',
  duration_ms: 284_000,
  explicit: false,
  is_local: false,
  is_playable: true,
  artists: [{ id: 'ar1', name: 'Tycho', type: 'artist', uri: 'spotify:artist:ar1' }],
  album: album('al1', 'Awake'),
  track_number: 1,
  disc_number: 1,
};

export const trackB = {
  ...trackA,
  id: '0VjIjW4GlUZAMYd2vXMi3b',
  uri: 'spotify:track:0VjIjW4GlUZAMYd2vXMi3b',
  name: 'Blinding Lights',
  duration_ms: 200_040,
  artists: [{ id: 'ar2', name: 'The Weeknd', type: 'artist', uri: 'spotify:artist:ar2' }],
  album: album('al2', 'After Hours'),
};

const localFile = {
  id: null,
  uri: 'spotify:local:Artist:Album:Song:180',
  name: 'Song',
  type: 'track',
  duration_ms: 180_000,
  is_local: true,
  artists: [{ name: 'Artist' }],
  album: { name: 'Album', images: [] },
};

const episode = { ...trackA, id: 'ep1', uri: 'spotify:episode:ep1', type: 'episode', name: 'A podcast' };

export const mePlaylistsPage1 = {
  href: 'https://api.spotify.com/v1/me/playlists?offset=0&limit=50',
  limit: 50,
  next: 'https://api.spotify.com/v1/me/playlists?offset=50&limit=50',
  offset: 0,
  previous: null,
  total: 2,
  items: [
    {
      collaborative: false,
      description: 'Late night <a href="spotify:x">drive</a> &amp; chill',
      id: 'pl1',
      images: [{ url: 'https://mosaic.scdn.co/640/pl1', width: 640, height: 640 }],
      name: 'Night Drive',
      owner: { id: 'me', display_name: 'Me' },
      public: false,
      items: { href: 'https://api.spotify.com/v1/playlists/pl1/items', total: 3 },
      type: 'playlist',
      uri: 'spotify:playlist:pl1',
    },
  ],
};

export const mePlaylistsPage2 = {
  ...mePlaylistsPage1,
  next: null,
  offset: 50,
  items: [
    {
      collaborative: true,
      description: '',
      id: 'pl2',
      images: null,
      name: 'Road Trip',
      owner: { id: 'friend', display_name: 'Friend' },
      tracks: { href: 'https://api.spotify.com/v1/playlists/pl2/tracks', total: 1 },
      type: 'playlist',
      uri: 'spotify:playlist:pl2',
    },
  ],
};

/** GET /playlists/pl1/items (Development Mode shape) */
export const playlistItemsNew = {
  href: 'https://api.spotify.com/v1/playlists/pl1/items?offset=0&limit=50',
  limit: 50,
  next: null,
  offset: 0,
  total: 4,
  items: [
    { added_at: '2026-01-01T00:00:00Z', is_local: false, item: trackA },
    { added_at: '2026-01-02T00:00:00Z', is_local: true, item: localFile },
    { added_at: '2026-01-03T00:00:00Z', is_local: false, item: episode },
    { added_at: '2026-01-04T00:00:00Z', is_local: false, item: trackB },
  ],
};

/** GET /playlists/pl2/tracks (classic shape) */
export const playlistTracksClassic = {
  href: 'https://api.spotify.com/v1/playlists/pl2/tracks?offset=0&limit=50',
  limit: 50,
  next: null,
  offset: 0,
  total: 2,
  items: [{ added_at: '2026-01-01T00:00:00Z', is_local: false, track: trackB }, { added_at: null, track: null }],
};

/** GET /me/tracks */
export const savedTracks = {
  href: 'https://api.spotify.com/v1/me/tracks?offset=0&limit=50',
  limit: 50,
  next: null,
  offset: 0,
  total: 2,
  items: [
    { added_at: '2026-02-01T00:00:00Z', track: trackA },
    { added_at: '2026-02-02T00:00:00Z', track: { ...trackB, is_playable: false } },
  ],
};

export const devices = {
  devices: [
    { id: 'dev-speaker', is_active: false, is_private_session: false, is_restricted: true, name: 'Kitchen', type: 'Speaker', volume_percent: 30, supports_volume: true },
    { id: 'dev-phone', is_active: true, is_private_session: false, is_restricted: false, name: 'Pixel', type: 'Smartphone', volume_percent: 100, supports_volume: false },
    { id: 'dev-mac', is_active: false, is_private_session: false, is_restricted: false, name: 'MacBook', type: 'Computer', volume_percent: 60, supports_volume: true },
  ],
};

export const playbackState = (over: { uri?: string; progress?: number; playing?: boolean; duration?: number } = {}) => ({
  device: devices.devices[1],
  repeat_state: 'off',
  shuffle_state: false,
  timestamp: Date.now(),
  progress_ms: over.progress ?? 1000,
  is_playing: over.playing ?? true,
  currently_playing_type: 'track',
  item: { ...trackA, uri: over.uri ?? trackA.uri, duration_ms: over.duration ?? trackA.duration_ms },
});

export const tokenResponse = {
  access_token: 'BQD-access-1',
  token_type: 'Bearer',
  scope: 'playlist-read-private user-library-read streaming',
  expires_in: 3600,
  refresh_token: 'AQD-refresh-1',
};
