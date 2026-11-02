// core/native (owner: native agent): thin wrappers over the Android/iOS shells. Every call is safe on web
// (no-op, web fallback, or 'unsupported').
export { isNative, platform, hasPlugin, sellsPlans, distribution, planLink, linksToPlans } from './platform';
export { nativeTts, type DeviceVoice, type SpeakOptions } from './tts';
export { audioFocus, mediaNotification, type MediaNotificationOptions } from './audio';
export { anyApp, type AnyAppNowPlaying, type AnyAppStateEvent } from './anyApp';
export { openAuthUrl, openExternal, isWebUrl, onDeepLink, onBrowserClosed, onForeground, APP_SCHEME } from './links';
export {
  speechToText,
  speechSupport,
  speechPermission,
  ensureSpeechPermission,
  stopSpeechToText,
  type SpeechPermission,
  type SpeechSupport,
  type SpeechToTextOptions,
} from './speech';
export { pickAudioFiles, AUDIO_ACCEPT, type PickOptions } from './files';
export { nativeFetch, nativeFetchBinary } from './http';
export {
  deviceStatus,
  requestNotificationPermission,
  openDeviceSettings,
  onAppResume,
  type DeviceStatus,
  type DeviceSettingsTarget,
} from './device';
export { startNativeShell, type NativeShellOptions } from './shell';
export { loopback, type LoopbackListener } from './loopback';
export {
  desktop,
  isDesktop,
  desktopFetch,
  desktopOsName,
  helperFetch,
  PROXY_ERROR_HEADER,
  type DesktopBridge,
  type DesktopSettings,
  type DesktopUpdate,
  type DesktopUpdateCheck,
  type DesktopWindowState,
} from './desktop';
export type { MediaActionEvent, MediaActionName, MediaActionReason, FocusState } from './plugin';
