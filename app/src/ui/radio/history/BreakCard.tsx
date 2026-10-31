// One aired break: who said what, around which songs, about which topics. "Play again" re-voices it.
import { useEffect, useRef, useState } from 'react';
import { Flag, Music2, Play, Square, Trash2 } from 'lucide-react';
import { deleteBreak, topicLabels } from '@/core/radio';
import type { Break, Host, Station } from '@/core/types';
import { playStandalone, speak, stopPreview } from '@/core/voice';
import { Avatar, Badge, IconButton, cx } from '../../components';
import { runAction } from '../../actions';
import { ReportBreakSheet, type ReportTarget } from '../ReportBreakSheet';
import './history.css';

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function songLine(b: Break): string | undefined {
  const s = (t?: Break['songBefore']) => (t ? `${t.title}${t.artist ? ` · ${t.artist}` : ''}` : undefined);
  const before = s(b.songBefore);
  const after = s(b.songAfter);
  if (b.topics.includes('callin')) return before ? `During ${before}` : undefined;
  if (before && after) return `After ${before}, before ${after}`;
  if (before) return `After ${before}`;
  if (after) return `Before ${after}`;
  return undefined;
}

export interface BreakCardProps {
  brk: Break;
  hosts: Host[];
  station?: Station;
  /** show the station name (history across stations) */
  showStation?: boolean;
  /** compact = first lines only (Home) */
  compact?: boolean;
  onOpen?: () => void;
}

export function BreakCard({ brk, hosts, station, showStation, compact, onOpen }: BreakCardProps) {
  const byId = new Map(hosts.map((h) => [h.id, h]));
  const [playing, setPlaying] = useState<number>();
  const [report, setReport] = useState<ReportTarget>();
  const cancel = useRef(false);
  useEffect(
    () => () => {
      cancel.current = true;
      stopPreview();
    },
    [],
  );

  const replay = async () => {
    if (playing !== undefined) {
      cancel.current = true;
      stopPreview();
      setPlaying(undefined);
      return;
    }
    cancel.current = false;
    try {
      for (let i = 0; i < brk.lines.length; i++) {
        if (cancel.current) break;
        const line = brk.lines[i]!;
        const host = byId.get(line.hostId) ?? hosts[0];
        if (!host) break;
        setPlaying(i);
        const clip = await speak(host, line.text);
        if (cancel.current) break;
        await playStandalone(clip, host.language);
      }
    } finally {
      setPlaying(undefined);
    }
  };

  const songs = songLine(brk);
  const topics = topicLabels(brk.topics);
  const lines = compact ? brk.lines.slice(0, 2) : brk.lines;
  return (
    <article className={cx('aw-break', compact && 'aw-break--compact', onOpen && 'aw-break--link')} onClick={onOpen}>
      <header className="aw-break__head">
        <span className="aw-break__time">{time(brk.at)}</span>
        {showStation && station && (
          <span className="aw-break__station">
            <span className="aw-break__dot" style={{ background: station.color }} aria-hidden />
            {station.name}
          </span>
        )}
        {brk.topics.includes('callin') && <Badge tone="warm">Call-in</Badge>}
        <span className="aw-break__spacer" />
        {!compact && (
          <>
            <IconButton
              icon={playing !== undefined ? Square : Play}
              size="sm"
              label={playing !== undefined ? 'Stop' : 'Play again'}
              onClick={(e) => {
                e.stopPropagation();
                void runAction(replay);
              }}
            />
            <IconButton
              icon={Flag}
              size="sm"
              label="Report this break"
              onClick={(e) => {
                e.stopPropagation();
                setReport({ lines: brk.lines, at: brk.at, stationName: station?.name });
              }}
            />
            <IconButton
              icon={Trash2}
              size="sm"
              label="Delete from history"
              onClick={(e) => {
                e.stopPropagation();
                void runAction(() => deleteBreak(brk.id));
              }}
            />
            <ReportBreakSheet target={report} onClose={() => setReport(undefined)} />
          </>
        )}
      </header>
      <ol className="aw-break__lines">
        {lines.map((l, i) => {
          const h = byId.get(l.hostId);
          return (
            <li key={i} className={cx('aw-break__line', playing === i && 'aw-break__line--on')}>
              <Avatar avatar={h?.avatar ?? { kind: 'monogram', value: '?', color: 'slate' }} name={h?.name ?? 'Host'} size={compact ? 28 : 32} speaking={playing === i} />
              <div className="aw-break__said">
                <span className="aw-break__who">{h?.name ?? 'A former host'}</span>
                <p className="aw-break__text">{l.text}</p>
              </div>
            </li>
          );
        })}
        {compact && brk.lines.length > lines.length && <li className="aw-break__more">+{brk.lines.length - lines.length} more</li>}
      </ol>
      {(songs || topics.length > 0) && !compact && (
        <footer className="aw-break__foot">
          {songs && (
            <span className="aw-break__songs">
              <Music2 aria-hidden />
              {songs}
            </span>
          )}
          {topics.length > 0 && (
            <span className="aw-break__topics">
              {topics.map((t) => (
                <span key={t} className="aw-break__topic">
                  {t}
                </span>
              ))}
            </span>
          )}
        </footer>
      )}
    </article>
  );
}
