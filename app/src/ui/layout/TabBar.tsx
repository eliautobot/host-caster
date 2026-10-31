import { useProfile } from '@/state/profile';
import { Avatar, Link, cx } from '../components';
import { NAV_ITEMS, type NavKey } from './nav';

/** Phone bottom tabs. Settings shows the listener's avatar. */
export function TabBar({ active }: { active?: NavKey }) {
  const profile = useProfile((s) => s.profile);
  const name = profile.callMe || profile.name || 'You';
  return (
    <nav className="aw-tabbar" aria-label="Main">
      {NAV_ITEMS.map(({ key, label, path, icon: Icon }) => (
        <Link
          key={key}
          to={path}
          replace
          className={cx('aw-tabbar__item', active === key && 'is-active')}
          aria-current={active === key ? 'page' : undefined}
        >
          {key === 'settings' ? (
            <Avatar
              name={name}
              size={24}
              avatar={{ kind: 'monogram', value: '', color: 'graphite' }}
              className="aw-tabbar__avatar"
            />
          ) : (
            <Icon aria-hidden strokeWidth={active === key ? 2.3 : 1.8} />
          )}
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
