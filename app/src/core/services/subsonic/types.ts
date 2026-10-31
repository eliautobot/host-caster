// Subset of the Subsonic / OpenSubsonic JSON shapes Host-Caster reads. Fields are optional because servers differ
// (Navidrome, Airsonic-Advanced, Gonic, Jellyfin plugin, Ampache, LMS ...).

export interface SubsonicSong {
  id: string;
  title?: string;
  album?: string;
  albumId?: string;
  artist?: string;
  artistId?: string;
  displayAlbumArtist?: string;
  track?: number;
  year?: number;
  genre?: string;
  coverArt?: string;
  /** seconds */
  duration?: number;
  suffix?: string;
  contentType?: string;
  starred?: string;
  isVideo?: boolean;
  type?: string;
}

export interface SubsonicAlbum {
  id: string;
  name?: string;
  title?: string;
  artist?: string;
  artistId?: string;
  coverArt?: string;
  songCount?: number;
  duration?: number;
  year?: number;
  genre?: string;
  starred?: string;
  song?: SubsonicSong[];
}

export interface SubsonicArtist {
  id: string;
  name: string;
  coverArt?: string;
  artistImageUrl?: string;
  albumCount?: number;
  starred?: string;
  album?: SubsonicAlbum[];
}

export interface SubsonicPlaylist {
  id: string;
  name: string;
  comment?: string;
  owner?: string;
  songCount?: number;
  duration?: number;
  coverArt?: string;
  entry?: SubsonicSong[];
}

export interface SubsonicServerInfo {
  version: string;
  type?: string;
  serverVersion?: string;
  openSubsonic?: boolean;
}

export type AlbumListType =
  | 'random'
  | 'newest'
  | 'highest'
  | 'frequent'
  | 'recent'
  | 'alphabeticalByName'
  | 'alphabeticalByArtist'
  | 'starred';

export interface SearchResult {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}

export interface Starred {
  artists: SubsonicArtist[];
  albums: SubsonicAlbum[];
  songs: SubsonicSong[];
}
