import { useRef, useState } from 'react';
import { Database, Download, HardDrive, ShieldAlert, Upload } from 'lucide-react';
import { auth, exportBackup, importBackup, wipeLocalData, type BackupFile } from '@/core/api';
import { db } from '@/core/db';
import { useSession } from '@/state/session';
import { runAction } from '../../actions';
import { Button, Toggle, toast } from '../../components';
import { DeleteAccountButton } from './account/DeleteAccount';
import { Actions, ConfirmSheet, Hint, SectionCard, formatBytes, useLoad } from './account/parts';
import './account/account.css';

interface Usage {
  hosts: number;
  stations: number;
  tracks: number;
  songBytes: number;
  otherBytes: number;
  used?: number;
  quota?: number;
}

async function readUsage(): Promise<Usage> {
  const [hosts, stations, tracks, localTracks] = await Promise.all([
    db.hosts.count(),
    db.stations.count(),
    db.tracks.count(),
    db.tracks.where('source').equals('local').toArray(),
  ]);
  const songIds = new Set(localTracks.map((t) => t.ref));
  let songBytes = 0;
  let otherBytes = 0;
  await db.blobs.each((b) => {
    if (songIds.has(b.id)) songBytes += b.size;
    else otherBytes += b.size;
  });
  const est = typeof navigator !== 'undefined' && navigator.storage?.estimate ? await navigator.storage.estimate().catch(() => undefined) : undefined;
  return { hosts, stations, tracks, songBytes, otherBytes, used: est?.usage, quota: est?.quota };
}

function download(file: Blob, name: string) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Data & storage (owner: server agent): usage, export/import backups, delete local data, delete account. */
export default function Data() {
  const session = useSession((s) => s.session);
  const usage = useLoad(readUsage, []);
  const [songs, setSongs] = useState(false);
  const [keys, setKeys] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<File>();
  const [wipe, setWipe] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const u = usage.data;

  const doExport = async () => {
    setExporting(true);
    await runAction(async () => {
      const { file, name, counts } = await exportBackup({ songs, keys, appVersion: __APP_VERSION__ });
      download(file, name);
      toast.success('Backup saved', `${counts.hosts ?? 0} hosts, ${counts.stations ?? 0} stations, ${counts.tracks ?? 0} songs listed · ${formatBytes(file.size)}`);
    });
    setExporting(false);
  };

  return (
    <div className="aw-acct-stack">
      <SectionCard icon={HardDrive} title="On this device" status={u?.used !== undefined ? `${formatBytes(u.used)} used${u.quota ? ` of ${formatBytes(u.quota)} available` : ''}` : 'Counting…'}>
        <div className="aw-acct-stat-grid">
          {[
            [u?.hosts, 'Hosts'],
            [u?.stations, 'Stations'],
            [u?.tracks, 'Songs'],
            [u ? formatBytes(u.songBytes) : undefined, 'Song files'],
          ].map(([v, label]) => (
            <div key={String(label)} className="aw-acct-stat">
              <p className="aw-acct-stat__value">{v ?? '…'}</p>
              <p className="aw-acct-stat__label">{label}</p>
            </div>
          ))}
        </div>
        {u?.used !== undefined && u.quota ? (
          <div className="aw-acct-meter" aria-hidden>
            <span style={{ width: `${Math.min(100, Math.max(1, (u.used / u.quota) * 100))}%` }} />
          </div>
        ) : null}
        <p className="aw-acct-desc">
          {session
            ? 'Hosts, stations, brains, voices and settings also sync to your account. Song files only live here and in backups.'
            : 'Local mode: everything lives only on this device. Make a backup now and then.'}
        </p>
      </SectionCard>

      <SectionCard icon={Database} title="Backup" status="One file with your hosts, stations, library, history and settings">
        <Toggle
          label="Include song files"
          description={u ? `Adds ${formatBytes(u.songBytes)}. Without it the backup lists your songs but not the audio.` : undefined}
          checked={songs}
          onChange={setSongs}
        />
        <Toggle label="Include API keys" description="Off keeps your AI and voice keys out of the file." checked={keys} onChange={setKeys} />
        <Actions>
          <Button variant="primary" icon={Download} loading={exporting} onClick={() => void doExport()}>
            Export backup
          </Button>
          <Button icon={Upload} onClick={() => input.current?.click()}>
            Import backup
          </Button>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setPending(f);
              e.target.value = '';
            }}
          />
        </Actions>
      </SectionCard>

      <SectionCard icon={ShieldAlert} title="Start over" status="These cannot be undone">
        <Actions>
          <Button variant="danger" onClick={() => setWipe(true)}>
            Delete data on this device
          </Button>
          {session && <DeleteAccountButton />}
        </Actions>
        <Hint>
          {session
            ? 'Deleting this device’s data signs you out here; your account keeps its synced copy. Deleting the account removes the server copy.'
            : 'Deleting removes every host, station, song and setting stored in this browser or app.'}
        </Hint>
      </SectionCard>

      <ConfirmSheet
        open={Boolean(pending)}
        onClose={() => setPending(undefined)}
        title="Replace this device’s data?"
        description={`Everything here is replaced with ${pending?.name ?? 'the backup'} (${formatBytes(pending?.size ?? 0)}). Signed in? Your account merges it on the next sync.`}
        confirmLabel="Import"
        onConfirm={async () => {
          const file = pending;
          if (!file) return;
          let header: BackupFile | undefined;
          if (await runAction(async () => (header = await importBackup(file)))) {
            setPending(undefined);
            toast.success('Backup restored', header ? `Made ${new Date(header.exportedAt).toLocaleString()}` : undefined);
            setTimeout(() => location.reload(), 900);
          }
        }}
      />
      <ConfirmSheet
        open={wipe}
        onClose={() => setWipe(false)}
        title="Delete everything on this device?"
        description="Hosts, stations, songs, history and settings stored here are deleted and Host-Caster starts fresh."
        confirmLabel="Delete everything"
        danger
        onConfirm={async () => {
          await runAction(async () => {
            if (session) await auth.signOut();
            await wipeLocalData();
            location.replace(location.pathname);
          });
        }}
      />
    </div>
  );
}
