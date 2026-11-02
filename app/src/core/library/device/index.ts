// Find music on this device (opt-in): look, show what was found per folder, add the songs as references to the files
// where they are, and (switch "Keep my music up to date") look again when the app opens or comes back: new songs are
// added, deleted ones removed, nothing else is touched. Device songs never sync to other devices.
import { db, getBlob, kvGet, kvSet, putBlob, saveTracks } from '../../db';
import { onForeground } from '../../native/links';
import type { Draft, Track } from '../../types';
import { createEmitter } from '../../util/emitter';
import { DuplicateIndex } from '../dedupe';
import { hash53, titleFromFileName } from '../text';
import { deleteTracks } from '../tracks';
import { notMusic } from './filters';
import { fileSig, isDuplicateSong, planDeviceSync, refPlatform, rememberSong, type DevicePlan, type SkippedFile } from './plan';
import { devicePlatform, scannerFor } from './scanners';
import { DEFAULT_DEVICE_SETTINGS, type DeviceAccess, type DeviceMusicSettings, type DevicePlatform, type DeviceRoot, type DeviceSong } from './types';

export * from './types';
export { devicePlatform, webFoldersSupported } from './scanners';
export { planDeviceSync, refPlatform, type DevicePlan } from './plan';
export { notMusic, musicOnly, MIN_SONG_MS } from './filters';

const SETTINGS_KEY = 'devicemusic:settings';
const SKIPPED_KEY = 'devicemusic:skipped';
/** after the app comes back, look again at most this often */
const RESCAN_GAP_MS = 60_000;
const BATCH = 50;

export interface DeviceMusicState {
  /** undefined: this app cannot find device music (the option stays hidden) */
  platform?: DevicePlatform;
  settings: DeviceMusicSettings;
  access: DeviceAccess;
  phase: 'idle' | 'scanning' | 'adding' | 'error';
  /** the last look, for the sheet */
  plan?: DevicePlan;
  /** adding: songs done / to do */
  progress?: { done: number; total: number };
  /** the last change to the library */
  result?: { added: number; removed: number; updated: number; skipped: number };
  error?: string;
  /** desktop/web: the folders picked */
  roots: DeviceRoot[];
  /** desktop: the system Music folder, when none is picked yet */
  suggested?: string;
}

class DeviceMusic {
  private emitter = createEmitter<{ change: DeviceMusicState }>();
  private _state: DeviceMusicState = { settings: DEFAULT_DEVICE_SETTINGS, access: 'unsupported', phase: 'idle', roots: [] };
  private scanned: DeviceSong[] = [];
  private busy?: Promise<unknown>;
  private lastAuto = 0;
  private loaded?: Promise<void>;
  /** files left out after reading their tags (not offered again until they change) */
  private skipped: Record<string, SkippedFile> = {};

  get state(): DeviceMusicState {
    return this._state;
  }

  on = this.emitter.on.bind(this.emitter);

  private set(patch: Partial<DeviceMusicState>) {
    this._state = { ...this._state, ...patch };
    this.emitter.emit('change', this._state);
  }

  /** settings, access and folders (cheap: no scan) */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      const platform = devicePlatform();
      const settings = { ...DEFAULT_DEVICE_SETTINGS, ...(await kvGet<DeviceMusicSettings>(SETTINGS_KEY))?.value };
      this.skipped = (await kvGet<Record<string, SkippedFile>>(SKIPPED_KEY))?.value ?? {};
      this.set({ platform, settings });
      await this.refresh();
    })();
    return this.loaded;
  }

  /** access + folders again (the person may have changed them in the system settings) */
  async refresh(): Promise<void> {
    const scanner = await scannerFor();
    if (!scanner) return this.set({ access: 'unsupported' });
    const [access, roots, suggested] = await Promise.all([
      scanner.access().catch((): DeviceAccess => 'denied'),
      scanner.roots?.().catch(() => []) ?? Promise.resolve([]),
      scanner.suggestedRoot?.().catch(() => undefined) ?? Promise.resolve(undefined),
    ]);
    this.set({ access, roots, suggested });
  }

  async saveSettings(patch: Partial<DeviceMusicSettings>): Promise<void> {
    const settings = { ...this._state.settings, ...patch };
    this.set({ settings });
    await kvSet(SETTINGS_KEY, settings);
  }

  /** Android: the permission prompt (from a tap). Returns the new access. */
  async requestAccess(): Promise<DeviceAccess> {
    const scanner = await scannerFor();
    if (!scanner) return 'unsupported';
    const access = await scanner.requestAccess().catch((): DeviceAccess => 'denied');
    this.set({ access });
    return access;
  }

  async openSettings(): Promise<void> {
    await (await scannerFor())?.openSettings?.();
  }

  /** desktop/web: pick a folder (desktop: `path` adds the suggested one) */
  async addRoot(path?: string): Promise<DeviceRoot | undefined> {
    const scanner = await scannerFor();
    const root = await scanner?.addRoot?.(path);
    await this.refresh();
    return root;
  }

  /** desktop/web: forget a folder; its songs leave the library */
  async removeRoot(id: string): Promise<void> {
    const scanner = await scannerFor();
    await scanner?.removeRoot?.(id);
    await this.refresh();
    if (this._state.settings.enabled) await this.sync({ quiet: true });
  }

  /** Looks (no changes yet): what is there, per folder. */
  look(): Promise<DevicePlan | undefined> {
    return this.exclusive(async () => {
      const scanner = await scannerFor();
      if (!scanner) return undefined;
      this.set({ phase: 'scanning', error: undefined });
      try {
        this.scanned = await scanner.scan();
        const plan = planDeviceSync(await db.tracks.toArray(), this.scanned, { platform: scanner.platform, excluded: this._state.settings.excluded, skipped: this.skipped });
        this.set({ phase: 'idle', plan });
        return plan;
      } catch (err) {
        this.set({ phase: 'error', error: message(err) });
        return undefined;
      }
    });
  }

  /** A folder switch: plan again from the last look (nothing is read again). */
  async setFolder(key: string, included: boolean): Promise<void> {
    const excluded = new Set(this._state.settings.excluded);
    if (included) excluded.delete(key);
    else excluded.add(key);
    await this.saveSettings({ excluded: [...excluded] });
    const platform = this._state.platform;
    if (platform && this.scanned.length) {
      this.set({ plan: planDeviceSync(await db.tracks.toArray(), this.scanned, { platform, excluded, skipped: this.skipped }) });
    }
  }

  /**
   * Brings the library in line with the device (after a look, or a fresh one): adds, updates, removes. Turns device
   * music on. `quiet` = an automatic look (no error shown when access is gone).
   */
  sync(opts: { quiet?: boolean; fresh?: boolean } = {}): Promise<DeviceMusicState['result']> {
    return this.exclusive(async () => {
      const scanner = await scannerFor();
      if (!scanner) return undefined;
      try {
        if (opts.fresh || !this.scanned.length) {
          this.set({ phase: 'scanning', error: undefined });
          this.scanned = await scanner.scan();
        }
        const library = await db.tracks.toArray();
        const plan = planDeviceSync(library, this.scanned, { platform: scanner.platform, excluded: this._state.settings.excluded, skipped: this.skipped });
        this.set({ phase: 'adding', plan, progress: { done: 0, total: plan.add.length + plan.update.length }, error: undefined });
        const result = { added: 0, removed: 0, updated: 0, skipped: 0 };
        if (plan.remove.length) {
          await deleteTracks(plan.remove.map((t) => t.id));
          result.removed = plan.remove.length;
        }
        const index = new DuplicateIndex(await db.tracks.toArray());
        const covers = new Map<string, string | undefined>();
        let drafts: Draft<Track>[] = [];
        let done = 0;
        const step = () => this.set({ progress: { done: ++done, total: plan.add.length + plan.update.length } });
        for (const s of plan.add) {
          const song = await this.withTags(s).catch(() => undefined);
          step();
          // tags read just now: a short file, or a song the library already has
          if (!song) {
            result.skipped++;
            continue;
          }
          const why = notMusic(song) ? 'short' : s.needsTags && isDuplicateSong(index, songMeta(song)) ? 'duplicate' : undefined;
          if (why) {
            this.skipped[s.ref] = { sig: fileSig(s), why };
            result.skipped++;
            continue;
          }
          if (s.needsTags) rememberSong(index, songMeta(song));
          drafts.push(toDraft(song, await this.cover(song, covers)));
          if (drafts.length >= BATCH) {
            result.added += (await saveTracks(drafts)).length;
            drafts = [];
          }
        }
        if (drafts.length) result.added += (await saveTracks(drafts)).length;
        for (const { track, song: s } of plan.update) {
          const song = await this.withTags(s).catch(() => undefined);
          step();
          if (!song) continue;
          const d = toDraft(song, (await this.cover(song, covers)) ?? track.artworkId);
          await db.tracks.update(track.id, { ...d, liked: track.liked, playCount: track.playCount, addedAt: track.addedAt, updatedAt: Date.now() });
          result.updated++;
        }
        // forget skipped files that are gone
        const present = new Set(this.scanned.map((x) => x.ref));
        for (const ref of Object.keys(this.skipped)) if (!present.has(ref)) delete this.skipped[ref];
        await kvSet(SKIPPED_KEY, this.skipped);
        await this.saveSettings({ enabled: true, lastScanAt: Date.now() });
        const after = planDeviceSync(await db.tracks.toArray(), this.scanned, { platform: scanner.platform, excluded: this._state.settings.excluded, skipped: this.skipped });
        this.set({ phase: 'idle', progress: undefined, result, plan: after });
        return result;
      } catch (err) {
        this.set({ phase: opts.quiet ? 'idle' : 'error', progress: undefined, error: message(err) });
        return undefined;
      }
    });
  }

  /** Turns device music off: its songs leave the library (the files stay where they are). */
  turnOff(): Promise<number> {
    return this.exclusive(async () => {
      const platform = this._state.platform;
      const mine = (await db.tracks.where('source').equals('device').toArray()).filter((t) => refPlatform(t.ref) === platform);
      await deleteTracks(mine.map((t) => t.id));
      // a fresh start next time: folder choices and skipped files are forgotten too
      await this.saveSettings({ enabled: false, excluded: [], lastScanAt: undefined });
      this.skipped = {};
      await kvSet(SKIPPED_KEY, this.skipped);
      this.scanned = [];
      this.set({ plan: undefined, result: undefined });
      return mine.length;
    });
  }

  /** On start and when the app comes back: "Keep my music up to date". Never asks for anything. */
  async autoSync(): Promise<void> {
    await this.load();
    const { settings, platform } = this._state;
    if (!platform || !settings.enabled || !settings.autoUpdate || this.busy) return;
    if (Date.now() - this.lastAuto < RESCAN_GAP_MS) return;
    this.lastAuto = Date.now();
    await this.refresh();
    if (this._state.access !== 'granted') return;
    await this.sync({ quiet: true, fresh: true });
  }

  private async withTags(s: DeviceSong): Promise<DeviceSong & { picture?: { data: Uint8Array; mime: string } }> {
    if (!s.needsTags) return s;
    const scanner = await scannerFor();
    return scanner?.readTags ? scanner.readTags(s) : s;
  }

  /** the song's cover (desktop/web: from its tags; Android: one per album) */
  private async cover(song: DeviceSong & { picture?: { data: Uint8Array; mime: string } }, cache: Map<string, string | undefined>): Promise<string | undefined> {
    if (song.picture) {
      const id = `art-${hash53(song.picture.data)}`;
      if (!(await getBlob(id))) await putBlob(new Blob([song.picture.data as Uint8Array<ArrayBuffer>], { type: song.picture.mime }), id);
      return id;
    }
    const key = song.albumKey ? `album:${song.albumKey}` : undefined;
    if (key && cache.has(key)) return cache.get(key);
    const scanner = await scannerFor();
    const blob = await scanner?.artwork?.(song).catch(() => undefined);
    let id: string | undefined;
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      id = `art-${hash53(bytes)}`;
      if (!(await getBlob(id))) await putBlob(blob, id);
    }
    if (key) cache.set(key, id);
    return id;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = (this.busy ?? Promise.resolve()).then(fn, fn);
    const tail: Promise<unknown> = run.then(
      () => this.busy === tail && (this.busy = undefined),
      () => this.busy === tail && (this.busy = undefined),
    );
    this.busy = tail;
    return run;
  }
}

const songMeta = (s: DeviceSong) => ({ title: s.title ?? titleFromFileName(s.name), artist: s.artist ?? 'Unknown artist', album: s.album ?? 'Unknown album', durationMs: s.durationMs });

export function toDraft(s: DeviceSong, artworkId: string | undefined): Draft<Track> {
  return {
    title: s.title ?? titleFromFileName(s.name),
    artist: s.artist ?? 'Unknown artist',
    album: s.album ?? 'Unknown album',
    albumArtist: s.albumArtist,
    year: s.year,
    genre: s.genre,
    trackNo: s.trackNo,
    discNo: s.discNo,
    durationMs: s.durationMs,
    artworkId,
    source: 'device',
    ref: s.ref,
    playCount: 0,
    addedAt: Date.now(),
    file: { name: s.name, path: s.path, size: s.size, mime: s.mime, modifiedAt: s.modifiedAt },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const deviceMusic = new DeviceMusic();

let started = false;
/** "Keep my music up to date": a look shortly after start and when the app comes back. */
export function startDeviceMusic(): void {
  if (started || !devicePlatform()) return;
  started = true;
  setTimeout(() => void deviceMusic.autoSync(), 4000);
  onForeground(() => void deviceMusic.autoSync());
}
