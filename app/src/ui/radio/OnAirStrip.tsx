import { useMemo, useState, type ReactNode } from 'react';
import { Flag, Mic } from 'lucide-react';
import { useHosts } from '@/state/hosts';
import { usePlayer } from '@/state/player';
import { useRadio } from '@/state/radio';
import { useStation } from '@/state/stations';
import { Avatar, AvatarStack, Button, IconButton, cx } from '../components';
import { lineup } from '../screens/parts/StationCard';
import { CallInSheet } from './CallInSheet';
import { ReportBreakSheet, type ReportTarget } from './ReportBreakSheet';
import './radio.css';

export interface OnAirStripProps {
  /** sheet = Now Playing card, bar = desktop player bar, mini = phone mini player */
  variant?: 'sheet' | 'bar' | 'mini';
  /** 'talking' = only while a host speaks or gets ready; default: sheet/bar always on air, mini only talking */
  when?: 'onair' | 'talking';
  className?: string;
}

/**
 * Live "ON AIR" strip: the speaking host's avatar, the live caption and "Talk to the hosts". Renders nothing when
 * the station is off air (or, with when="talking", while only music plays), so the player chrome can always mount it.
 */
export function OnAirStrip({ variant = 'sheet', when, className }: OnAirStripProps) {
  const r = useRadio();
  const station = useStation(r.stationId);
  const all = useHosts((s) => s.hosts);
  const hosts = useMemo(() => (station ? lineup(all, station.hostIds) : []), [all, station]);
  const live = usePlayer((p) => Boolean(p.live));
  const [callIn, setCallIn] = useState(false);
  const [report, setReport] = useState<ReportTarget>();
  const mode = when ?? (variant === 'mini' ? 'talking' : 'onair');
  const phase = r.phase ?? (r.onAir ? 'music' : 'off');
  const speaking = all.find((h) => h.id === r.speakingHostId);
  const lead = speaking ?? hosts[0];
  const talking = phase === 'talking' && Boolean(speaking);
  const preparing = phase === 'preparing';

  if (!r.onAir || (mode === 'talking' && !talking && !preparing)) return null;

  const names = hosts.map((h) => h.name).join(' & ') || 'Your hosts';
  const status = talking ? speaking!.name : preparing ? `${lead?.name ?? 'Your host'} is getting ready` : names;
  const caption = talking
    ? r.caption
    : preparing
      ? 'Writing the next break...'
      : (r.notice ??
        (live ? 'Breaking in every few minutes' : r.nextBreakIn <= 1 ? 'On the mic after this song' : `On the mic in ${r.nextBreakIn} songs`));
  // Now Playing: report the break on air, else the last one (it stays as it was while the sheet is open)
  const toReport = phase === 'talking' && r.script?.length ? { lines: r.script, at: Date.now() } : r.lastBreak;
  const talkButton =
    variant === 'sheet' ? (
      <span className="aw-onair__actions">
        {toReport && (
          <IconButton
            icon={Flag}
            label="Report this break"
            size="sm"
            className="aw-onair__report"
            onClick={() => setReport({ lines: toReport.lines, at: toReport.at, stationName: station?.name })}
          />
        )}
        <Button size="sm" icon={Mic} onClick={() => setCallIn(true)} className="aw-onair__talk aw-onair__talk--full">
          Talk to the hosts
        </Button>
        {/* narrow phones: the mic alone, so the host's name keeps its room */}
        <IconButton icon={Mic} label="Talk to the hosts" size="sm" variant="solid" onClick={() => setCallIn(true)} className="aw-onair__talk aw-onair__talk--icon" />
      </span>
    ) : (
      <IconButton icon={Mic} label="Talk to the hosts" size="sm" variant="solid" onClick={() => setCallIn(true)} />
    );

  return (
    <>
      <section
        className={cx('aw-onair', `aw-onair--${variant}`, talking && 'aw-onair--talking', preparing && 'aw-onair--preparing', className)}
        aria-label="On air"
        aria-live="polite"
      >
        <span className="aw-onair__who">
          {talking || preparing || hosts.length <= 1 ? (
            lead && <Avatar avatar={lead.avatar} name={lead.name} size={variant === 'sheet' ? 44 : 32} speaking={talking} />
          ) : (
            <AvatarStack people={hosts} size={variant === 'sheet' ? 36 : 26} />
          )}
        </span>
        <span className="aw-onair__text">
          <span className="aw-onair__status">
            <span className="aw-onair__live" aria-hidden />
            <span className="aw-onair__kicker">On air</span>
            <span className="aw-onair__name aw-truncate">{status}</span>
          </span>
          {caption && (
            <span key={`${r.lineIndex ?? -1}:${phase}`} className="aw-onair__caption">
              {caption}
            </span>
          )}
        </span>
        {talkButton}
      </section>
      <CallInSheet open={callIn} onClose={() => setCallIn(false)} onOpen={() => setCallIn(true)} />
      {variant === 'sheet' && <ReportBreakSheet target={report} onClose={() => setReport(undefined)} />}
    </>
  );
}

/** A plain "Talk to the hosts" button that opens the call-in sheet (Home, Now Playing). */
export function TalkToHostsButton(props: { size?: 'sm' | 'md' | 'lg'; variant?: 'primary' | 'secondary'; className?: string; label?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={props.size ?? 'md'} variant={props.variant ?? 'secondary'} icon={Mic} className={props.className} onClick={() => setOpen(true)}>
        {props.label ?? 'Talk to the hosts'}
      </Button>
      <CallInSheet open={open} onClose={() => setOpen(false)} onOpen={() => setOpen(true)} />
    </>
  );
}
