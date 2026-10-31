import { Suspense } from 'react';
import { useProfile } from '@/state/profile';
import { useSession } from '@/state/session';
import { navigate } from '@/state/router';
import { Button, Card, List, ListRow, SkeletonText } from '../components';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { Page } from '../layout/Page';
import { LegalLinks } from '../online/legal';
import { AccountAvatar } from './settings/account/AccountAvatar';
import { getSettingsPage, settingsPages, SETTINGS_GROUPS, type SettingsPageDef } from './settings/pages';
import type { ScreenProps } from '.';
import './Settings.css';

function SettingsNav({ current }: { current?: string }) {
  const profile = useProfile((s) => s.profile);
  // signed in: the account (photo, sync state); signed out: local mode with a Sign in button
  const user = useSession((s) => s.session?.user);
  const syncStatus = useSession((s) => s.sync.status);
  const name = profile.name || user?.name || 'You';
  const meta = !user
    ? 'Local only'
    : syncStatus === 'offline'
      ? 'Offline, changes sync later'
      : syncStatus === 'error'
        ? 'Sync problem'
        : user.email || user.identities?.find((i) => i.label)?.label || 'Signed in';
  return (
    <div className="aw-settings__nav">
      <Card padding="compact" className="aw-settings__me">
        <AccountAvatar name={name} url={user?.avatarUrl} size={48} />
        <div className="aw-settings__me-text">
          <p className="aw-settings__me-name">{name}</p>
          <p className="aw-settings__me-meta">{meta}</p>
        </div>
        {user ? (
          <Button size="sm" variant="ghost" onClick={() => navigate('/settings/account')}>
            Account
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => navigate('/sign-in')}>
            Sign in
          </Button>
        )}
      </Card>
      {SETTINGS_GROUPS.map((group) => (
        <div key={group} className="aw-settings__group">
          <p className="aw-settings__group-title">{group}</p>
          <List>
            {settingsPages
              .filter((p) => p.group === group && (p.visible?.() ?? true))
              .map((p) => (
                <ListRow
                  key={p.id}
                  to={`/settings/${p.id}`}
                  leading={p.icon}
                  title={p.title}
                  subtitle={p.description}
                  active={p.id === current}
                  chevron
                />
              ))}
          </List>
        </div>
      ))}
      <LegalLinks className="aw-settings__version aw-settings__legal" />
      <p className="aw-settings__version">Host-Caster {__APP_VERSION__}</p>
    </div>
  );
}

function PageBody({ page }: { page: SettingsPageDef }) {
  const Screen = page.screen;
  return (
    <Suspense fallback={<SkeletonText lines={4} />}>
      <Screen />
    </Suspense>
  );
}

export default function Settings({ params }: ScreenProps) {
  const isDesktop = useIsDesktop();
  const page = getSettingsPage(params.page);

  if (!isDesktop) {
    if (page) {
      return (
        <Page back="/settings" title={page.title} subtitle={page.description} width="narrow">
          <PageBody page={page} />
        </Page>
      );
    }
    return (
      <Page title="Settings" width="narrow">
        <SettingsNav />
      </Page>
    );
  }

  const shown = page ?? settingsPages[0]!;
  return (
    <Page title="Settings">
      <div className="aw-settings">
        <SettingsNav current={shown.id} />
        <section aria-labelledby="settings-pane-title">
          <div className="aw-settings__pane-head">
            <h2 className="aw-settings__pane-title" id="settings-pane-title">
              {shown.title}
            </h2>
            <p className="aw-settings__pane-desc">{shown.description}</p>
          </div>
          <PageBody page={shown} />
        </section>
      </div>
    </Page>
  );
}
