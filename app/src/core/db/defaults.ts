// Default rows and starter content. Seed ids are fixed so two devices that seed separately merge cleanly on sync.
import {
  DEVICE_VOICE_ID,
  PROFILE_ID,
  SETTINGS_ID,
  type Host,
  type Profile,
  type Settings,
  type Station,
  type StationSegments,
  type Units,
} from '../types';

export const SEED_IDS = {
  maya: 'seed-host-maya',
  jules: 'seed-host-jules',
  rex: 'seed-host-rex',
  station: 'seed-station-881',
} as const;

function guessUnits(): Units {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return /^en-(US|LR|MM)$/i.test(lang) ? 'imperial' : 'metric';
}

export function defaultProfile(now = Date.now()): Profile {
  return {
    id: PROFILE_ID,
    createdAt: now,
    updatedAt: now,
    name: '',
    callMe: '',
    about: '',
    units: guessUnits(),
    lifeEvents: [],
    notes: [],
    reminders: [],
    interests: [],
    avoidTopics: [],
  };
}

export function defaultSettings(now = Date.now()): Settings {
  return {
    id: SETTINGS_ID,
    createdAt: now,
    updatedAt: now,
    theme: 'dark',
    activeStationId: SEED_IDS.station,
    connections: {},
    onboarded: false,
  };
}

export function defaultSegments(): StationSegments {
  return {
    songs: true,
    time: true,
    weather: true,
    calendar: true,
    // only airs once a mailbox is connected (connecting one also switches it on for every station)
    email: true,
    news: true,
    lifeEvents: true,
    notes: true,
    reminders: true,
    funFacts: true,
  };
}

type HostSeed = Omit<Host, 'createdAt' | 'updatedAt'>;

const deviceVoice = (speed: number, pitch: number) => ({ voiceProviderId: DEVICE_VOICE_ID, voiceId: '', speed, pitch });

export const STARTER_HOSTS: HostSeed[] = [
  {
    id: SEED_IDS.maya,
    name: 'Maya',
    avatar: { kind: 'monogram', value: 'M', color: 'sunrise' },
    tagline: 'Your bright start to the day',
    personality:
      'Maya is a sunny morning host who loves strong coffee, early walks and the first song of the day. ' +
      'She notices small wins, remembers what you have going on and gets you moving without being pushy.',
    style: 'Warm, upbeat and quick. Short sentences, real enthusiasm, a friendly nudge to get going.',
    energy: 4,
    humor: 3,
    verbosity: 2,
    language: 'en',
    catchphrases: ['Rise and shine', "Let's get this day moving"],
    topics: ['the day ahead', 'weather', 'music trivia'],
    avoid: [],
    voice: deviceVoice(1.05, 1.05),
    brainId: null,
  },
  {
    id: SEED_IDS.jules,
    name: 'Jules',
    avatar: { kind: 'monogram', value: 'J', color: 'dusk' },
    tagline: 'Stories for the quiet hours',
    personality:
      'Jules is a calm late-night storyteller. Finds the story behind a song, remembers old places and ' +
      'small details, and makes the night feel a little less empty.',
    style: 'Slow, soft and thoughtful. Vivid little details, gentle pauses, never loud.',
    energy: 1,
    humor: 2,
    verbosity: 4,
    language: 'en',
    catchphrases: ['Stay with me a while', "Here's one for the night owls"],
    topics: ['the story behind the song', 'memories', 'the night sky'],
    avoid: [],
    voice: deviceVoice(0.92, 0.9),
    brainId: null,
  },
  {
    id: SEED_IDS.rex,
    name: 'Rex',
    avatar: { kind: 'monogram', value: 'R', color: 'ember' },
    tagline: 'Fast takes, big energy',
    personality:
      'Rex runs the show like a sports-radio desk: stats, hot takes and playful trash talk about your ' +
      'playlist. Quick, witty and always one joke ahead.',
    style: 'Punchy and fast. Play-by-play energy, quick jokes, confident calls.',
    energy: 5,
    humor: 5,
    verbosity: 2,
    language: 'en',
    catchphrases: ["And that's a wrap on that one", 'Call it now'],
    topics: ['sports', 'song stats', 'hot takes'],
    avoid: [],
    voice: deviceVoice(1.12, 0.95),
    brainId: null,
  },
];

export const STARTER_STATION: Omit<Station, 'createdAt' | 'updatedAt'> = {
  id: SEED_IDS.station,
  name: 'Host-Caster 88.1',
  frequency: '88.1',
  color: '#ff5a36',
  description: 'Your library, hosted by Maya and Jules.',
  sources: [{ kind: 'library' }],
  hostIds: [SEED_IDS.maya, SEED_IDS.jules],
  talkEvery: 2,
  talkLength: 'normal',
  segments: defaultSegments(),
  talkOverIntro: true,
  duckLevel: 0.18,
  newsFeeds: [],
  shuffle: true,
};
