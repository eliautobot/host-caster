import { Plus } from 'lucide-react';
import { useActiveStation, useStations } from '@/state/stations';
import { useRadio } from '@/state/radio';
import { useRoute } from '@/state/router';
import { useProfile } from '@/state/profile';
import { useSession } from '@/state/session';
import { AccountAvatar } from '../screens/settings/account/AccountAvatar';
import { Badge, IconButton, Link, Logo, StationArt, cx } from '../components';
import { navigate } from '@/state/router';
import { NAV_ITEMS, type NavKey } from './nav';

export function Sidebar({ active }: { active?: NavKey }) {
  const stations = useStations((s) => s.stations);
  const activeStation = useActiveStation();
  const radio = useRadio();
  const path = useRoute((r) => r.path);
  const profile = useProfile((s) => s.profile);
  const user = useSession((s) => s.session?.user);
  const syncStatus = useSession((s) => s.sync.status);
  const displayName = profile.callMe || profile.name || user?.name || 'You';
  const accountMeta = !user
    ? 'Local only · Sign in to sync'
    : syncStatus === 'offline'
      ? 'Offline · syncs later'
      : syncStatus === 'error'
        ? 'Sync problem'
        : user.email || 'Synced';

  return (
    <nav className="aw-sidebar" aria-label="Main">
      <div className="aw-sidebar__brand">
        <Link to="/" aria-label="Host-Caster home">
          <Logo size={30} />
        </Link>
      </div>

      <ul className="aw-sidebar__nav">
        {NAV_ITEMS.map(({ key, label, path: to, icon: Icon }) => (
          <li key={key}>
            <Link to={to} className={cx('aw-navlink', active === key && 'is-active')} aria-current={active === key ? 'page' : undefined}>
              <Icon aria-hidden strokeWidth={active === key ? 2.3 : 1.9} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>

      <div className="aw-sidebar__section">
        <div className="aw-sidebar__section-head">
          <span>Your stations</span>
          <IconButton icon={Plus} label="New station" size="sm" onClick={() => navigate('/stations/new')} />
        </div>
        <ul className="aw-sidebar__stations">
          {stations.map((s) => {
            const live = radio.onAir && radio.stationId === s.id;
            const isCurrent = path === `/stations/${s.id}`;
            return (
              <li key={s.id}>
                <Link to={`/stations/${s.id}`} className={cx('aw-stationlink', isCurrent && 'is-active')}>
                  <StationArt color={s.color} frequency={s.frequency} size={40} />
                  <span className="aw-stationlink__text">
                    <span className="aw-stationlink__name">{s.name}</span>
                    <span className="aw-stationlink__meta">
                      {live ? (
                        <Badge tone="accent" dot="live">
                          Live
                        </Badge>
                      ) : (
                        <>
                          {s.frequency} FM · {s.hostIds.length} {s.hostIds.length === 1 ? 'host' : 'hosts'}
                          {s.id === activeStation?.id && ' · Tuned in'}
                        </>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>

      <Link to="/settings/account" className="aw-sidebar__account">
        <AccountAvatar name={displayName} url={user?.avatarUrl} size={32} />
        <span className="aw-sidebar__account-text">
          <span className="aw-sidebar__account-name">{displayName}</span>
          <span className="aw-sidebar__account-meta">{accountMeta}</span>
        </span>
      </Link>
    </nav>
  );
}
