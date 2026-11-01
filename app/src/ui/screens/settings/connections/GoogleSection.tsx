import { useEffect, useState } from 'react';
import { CalendarDays, LogIn, Mail, RefreshCw, SquarePlay } from 'lucide-react';
import { api, auth, integrations, youtube, type GoogleService } from '@/core/api';
import type { Connections } from '@/core/types';
import { navigate, useRoute } from '@/state/router';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { runAction } from '../../../actions';
import { Button, IconButton, Toggle } from '../../../components';
import { useIsDesktop } from '../../../hooks/useMediaQuery';
import { GoogleMark } from '../account/marks';
import { Actions, Hint, SectionCard, errorText } from '../account/parts';
import { emailOnForStations } from './emailOn';

interface Service {
  id: GoogleService;
  icon: typeof Mail;
  label: string;
  description: string;
  get: (c: Connections) => boolean | undefined;
  set: (c: Connections, on: boolean) => Connections;
  check: () => Promise<string>;
}

const SERVICES: Service[] = [
  {
    id: 'calendar',
    icon: CalendarDays,
    label: 'Google Calendar',
    description: 'What is coming up today and tomorrow, from every calendar you see in Google Calendar.',
    get: (c) => c.calendar?.google,
    set: (c, on) => ({ ...c, calendar: { icsUrls: c.calendar?.icsUrls ?? [], google: on } }),
    check: async () => {
      const r = await integrations.calendar(36);
      return `${r.events.length} event${r.events.length === 1 ? '' : 's'} in the next 36 hours, from ${r.calendars} calendar${r.calendars === 1 ? '' : 's'}`;
    },
  },
  {
    id: 'gmail',
    icon: Mail,
    label: 'Gmail',
    description: 'Unread mail, important first. Hosts mention who wrote and the subject, never the whole message.',
    get: (c) => c.email?.gmail,
    set: (c, on) => ({ ...c, email: { imap: c.email?.imap ?? false, gmail: on } }),
    check: async () => {
      const r = await integrations.email(10);
      const important = r.messages.filter((m) => m.important).length;
      return `${r.unread} unread${important ? `, ${important} important` : ''}`;
    },
  },
  {
    id: 'youtube',
    icon: SquarePlay,
    label: 'YouTube',
    description: 'Your playlists and Liked videos for stations (Settings, Music services).',
    get: (c) => c.youtube?.connected,
    set: (c, on) => ({ ...c, youtube: { connected: on } }),
    check: async () => {
      const r = await youtube.playlists();
      return `${r.playlists.length} playlist${r.playlists.length === 1 ? '' : 's'} including Liked videos`;
    },
  },
];

export function GoogleSection() {
  const session = useSession((s) => s.session);
  const config = useSession((s) => s.config);
  const connections = useSettings((s) => s.settings.connections);
  const ready = useSettings((s) => s.ready);
  const update = useSettings((s) => s.update);
  const query = useRoute((r) => r.query);
  const isDesktop = useIsDesktop();
  const [checks, setChecks] = useState<Record<string, string>>({});
  const identity = session?.user.identities?.find((i) => i.provider === 'google');
  const granted = new Set(identity?.scopes ?? []);

  // back from Google's consent screen with ?enable=calendar: switch that service on
  useEffect(() => {
    if (!ready || !query.enable || !identity) return;
    const svc = SERVICES.find((s) => s.id === query.enable);
    if (svc && granted.has(svc.id) && !svc.get(connections)) void update({ connections: svc.set(connections, true) }).then(() => (svc.id === 'gmail' ? emailOnForStations() : undefined));
    navigate('/settings/connections', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, query.enable, identity?.scopes.join()]);

  if (!config?.signIn.google) {
    return (
      <SectionCard icon={CalendarDays} title="Google Calendar and Gmail" status="Not set up on this server">
        <Hint>The server owner can turn on Google sign-in (see the self-hosting guide). ICS calendar links below work without it.</Hint>
      </SectionCard>
    );
  }

  const toggle = async (svc: Service, on: boolean) => {
    if (on && !granted.has(svc.id)) {
      await runAction(() => auth.connectGoogle([svc.id], `/settings/connections?enable=${svc.id}`));
      return;
    }
    await update({ connections: svc.set(connections, on) });
    if (on && svc.id === 'gmail') await emailOnForStations();
  };

  const check = async (svc: Service) => {
    setChecks((c) => ({ ...c, [svc.id]: 'Checking…' }));
    try {
      const text = await svc.check();
      setChecks((c) => ({ ...c, [svc.id]: text }));
    } catch (err) {
      setChecks((c) => ({ ...c, [svc.id]: errorText(err) }));
    }
  };

  return (
    <SectionCard
      icon={CalendarDays}
      tone={identity ? 'ok' : 'neutral'}
      title="Google"
      status={identity ? `Connected as ${identity.label}` : session ? 'Not linked to this account' : 'Sign in with Google to connect'}
      badge={identity ? { label: 'Connected', tone: 'ok', dot: true } : undefined}
    >
      {session ? (
        <>
          <div className="aw-acct-rows">
            {SERVICES.map((svc) => {
              const on = Boolean(svc.get(connections)) && granted.has(svc.id);
              return (
                <div key={svc.id} className="aw-acct-row">
                  <span className="aw-acct-row__icon">
                    <svc.icon aria-hidden />
                  </span>
                  <span className="aw-acct-row__text">
                    <span className="aw-acct-row__title">{svc.label}</span>
                    <span className="aw-acct-row__sub" title={svc.description}>
                      {checks[svc.id] || (granted.has(svc.id) ? svc.description : 'Asks Google for read-only access')}
                    </span>
                  </span>
                  <span className="aw-acct-row__end">
                    {on &&
                      (isDesktop ? (
                        <Button size="sm" variant="ghost" onClick={() => void check(svc)} disabled={!api.available}>
                          Check
                        </Button>
                      ) : (
                        <IconButton icon={RefreshCw} label={`Check ${svc.label}`} size="sm" onClick={() => void check(svc)} disabled={!api.available} />
                      ))}
                    <Toggle checked={on} onChange={(v) => void toggle(svc, v)} aria-label={svc.label} />
                  </span>
                </div>
              );
            })}
          </div>
          {!identity && (
            <Actions>
              <Button className="aw-signin__provider" onClick={() => void runAction(() => auth.connectGoogle(['calendar', 'gmail'], '/settings/connections?enable=calendar'))}>
                <GoogleMark />
                Link Google
              </Button>
            </Actions>
          )}
          <Hint>
            Read-only. Your server fetches it when the hosts need it; nothing is stored beyond a short cache on this device. Remove access any time
            in your Google Account under Security, Third-party connections.
          </Hint>
        </>
      ) : (
        <Actions>
          <Button variant="primary" icon={LogIn} onClick={() => navigate('/sign-in')}>
            Sign in
          </Button>
        </Actions>
      )}
    </SectionCard>
  );
}
