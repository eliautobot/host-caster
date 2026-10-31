// "Report this break": flag something the AI hosts said (store rules for AI content), without leaving the app. Sends
// the break's lines and an optional note to the Host-Caster server; signed out (or no server) it says to sign in.
import { useEffect, useState } from 'react';
import { Flag, LogIn } from 'lucide-react';
import { ApiError, breakReport, reports, REPORT_NOTE_MAX, SIGN_IN_TO_REPORT } from '@/core/api';
import type { BreakLine } from '@/core/types';
import { useHosts } from '@/state/hosts';
import { navigate } from '@/state/router';
import { useSession } from '@/state/session';
import { Button, Sheet, TextArea, toast } from '../components';
import './report.css';

/** The break to report: its lines and when it aired. */
export interface ReportTarget {
  lines: readonly BreakLine[];
  at: number;
  stationName?: string;
}

export function ReportBreakSheet({ target, onClose }: { target?: ReportTarget; onClose: () => void }) {
  const hosts = useHosts((s) => s.hosts);
  const canSend = useSession((s) => s.available && Boolean(s.session));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // the sheet keeps showing the last break while it closes
  const [shown, setShown] = useState(target);
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setNote('');
    setError(undefined);
  }, [target]);

  const byId = new Map(hosts.map((h) => [h.id, h.name]));
  const send = async () => {
    if (!shown) return;
    setBusy(true);
    setError(undefined);
    try {
      await reports.send(breakReport(shown.lines, hosts, { at: shown.at, stationName: shown.stationName, note }));
      onClose();
      toast.success('Thanks. We will look at it.');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? SIGN_IN_TO_REPORT : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={Boolean(target)}
      onClose={() => !busy && onClose()}
      size="sm"
      title="Report this break"
      description={canSend ? 'Something your AI hosts said was offensive or wrong? Tell us. We read every report.' : undefined}
      footer={
        canSend ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" icon={Flag} loading={busy} onClick={() => void send()}>
              Send report
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button
              variant="primary"
              icon={LogIn}
              onClick={() => {
                onClose();
                navigate('/sign-in');
              }}
            >
              Sign in
            </Button>
          </>
        )
      }
    >
      {canSend ? (
        <div className="aw-report">
          <ol className="aw-report__lines" aria-label="What the hosts said">
            {shown?.lines.map((l, i) => (
              <li key={i}>
                <span className="aw-report__who">{byId.get(l.hostId) ?? 'A former host'}</span>
                <span className="aw-report__text">{l.text}</span>
              </li>
            ))}
          </ol>
          <TextArea
            label="Add a note (optional)"
            placeholder="What was wrong with it?"
            value={note}
            onChange={setNote}
            maxLength={REPORT_NOTE_MAX}
            rows={2}
            autoResize
            data-autofocus
            error={error}
          />
        </div>
      ) : (
        <p className="aw-report__signin" data-report-signin>
          {SIGN_IN_TO_REPORT}. Reports go to the people who run your Host-Caster server, so they need an account.
        </p>
      )}
    </Sheet>
  );
}
