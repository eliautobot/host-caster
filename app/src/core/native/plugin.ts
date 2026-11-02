// The app's own native plugin (Java: android/app/src/main/java/com/hostcaster/app/audio, Swift: ios/App/App/HostCaster*.swift).
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type MediaActionName = 'play' | 'pause' | 'next' | 'prev' | 'seek' | 'stop';
/** user = notification, lock screen, headset; noisy = headphones unplugged (Android); interruption = a call (iOS) */
export type MediaActionReason = 'user' | 'noisy' | 'interruption';
export type FocusState = 'gain' | 'loss' | 'loss_transient' | 'duck';

export interface MediaActionEvent {
  action: MediaActionName;
  positionMs: number;
  reason: MediaActionReason;
}

/** Raw now-playing from the plugin (key '' = nothing is playing anywhere). */
export interface RawAnyAppNowPlaying {
  key: string;
  packageName?: string;
  appName?: string;
  title?: string;
  artist?: string;
  album?: string;
  durationMs?: number;
  artworkUrl?: string;
  playing: boolean;
  positionMs?: number;
  at?: number;
}

export interface AnyAppStateEvent {
  packageName: string;
  playing: boolean;
  state: 'playing' | 'paused' | 'buffering' | 'stopped' | 'skipping' | 'error' | 'none';
  positionMs: number;
  speed: number;
  at: number;
}

export interface DeviceStatus {
  platform: 'android' | 'ios';
  sdk?: number;
  release?: string;
  manufacturer?: string;
  model?: string;
  notifications: 'granted' | 'denied' | 'prompt';
  anyAppSupported: boolean;
  anyAppAccess: boolean;
  /** Android: battery optimization off for Host-Caster (best for long background sessions) */
  batteryUnrestricted?: boolean;
}

export interface HostCasterAudioPlugin {
  updateNowPlaying(opts: {
    title: string;
    artist: string;
    album?: string;
    durationMs?: number;
    positionMs?: number;
    playing: boolean;
    canPrev?: boolean;
    canNext?: boolean;
    /** Host-Caster plays the music itself (default); false in any-app mode (another app plays it) */
    ownAudio?: boolean;
    artworkKey?: string;
    artworkBase64?: string;
    artworkUrl?: string;
  }): Promise<void>;
  clearNowPlaying(): Promise<void>;
  duck(): Promise<{ result: 'granted' | 'own' | 'failed' | 'delayed' | 'unsupported' }>;
  releaseFocus(): Promise<void>;
  holdCallFocus(): Promise<{ result: 'granted' | 'failed' | 'delayed' }>;
  releaseCallFocus(): Promise<void>;
  /** iOS: back to the playback audio session after speech recognition (no-op on Android) */
  restoreSession(): Promise<void>;
  playClip(opts: { base64: string; ext?: string; volume?: number }): Promise<void>;
  stopClip(): Promise<void>;
  anyAppStatus(): Promise<{ supported: boolean; access: boolean; running: boolean }>;
  anyAppStart(): Promise<{ access: boolean; running: boolean; nowPlaying?: RawAnyAppNowPlaying }>;
  anyAppStop(): Promise<void>;
  anyAppNowPlaying(): Promise<RawAnyAppNowPlaying>;
  anyAppControl(opts: { action: 'play' | 'pause' | 'next' | 'prev' | 'seek'; positionMs?: number }): Promise<{ ok: boolean }>;
  deviceStatus(): Promise<DeviceStatus>;
  requestNotifications(): Promise<{ notifications: DeviceStatus['notifications'] }>;
  openSettings(opts: { target: 'app' | 'notifications' | 'battery' | 'anyapp' }): Promise<void>;
  addListener(event: 'media', cb: (e: MediaActionEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'focus', cb: (e: { state: FocusState }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'anyAppTrack', cb: (e: RawAnyAppNowPlaying) => void): Promise<PluginListenerHandle>;
  addListener(event: 'anyAppState', cb: (e: AnyAppStateEvent) => void): Promise<PluginListenerHandle>;
}

export const HostCasterAudio = registerPlugin<HostCasterAudioPlugin>('HostCasterAudio');
