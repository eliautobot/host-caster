import { Suspense, useEffect, useRef, useState, type CSSProperties } from 'react';
import { back, useRoute } from '@/state/router';
import { useSession } from '@/state/session';
import { Sheet, Skeleton, Toaster } from '../components';
import { useApplyTheme } from '../hooks/useApplyTheme';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { MiniPlayer } from '../player/MiniPlayer';
import { PlayerBar } from '../player/PlayerBar';
import { resolveScreen, screens, type ScreenMatch } from '../screens';
import { UpdateNotice } from '../update/UpdateNotice';
import { Sidebar } from './Sidebar';
import { TabBar } from './TabBar';
import './layout.css';

const HOME: ScreenMatch = { def: screens[0]!, params: {} };

function PageFallback() {
  return (
    <div className="aw-page-fallback" aria-hidden>
      <Skeleton width={220} height={36} radius={10} />
      <Skeleton width="100%" height={180} radius={16} />
      <Skeleton width="60%" height={14} />
    </div>
  );
}

export function AppShell() {
  useApplyTheme();
  const route = useRoute();
  const isDesktop = useIsDesktop();
  const match = resolveScreen(route.path);
  const isSheet = match.def.presentation === 'sheet';
  // online edition: nothing but the sign-in page until signed in with a confirmed email
  const gated = useSession((s) => s.config?.edition === 'online' && s.ready && !(s.session && s.session.user.emailVerified));

  // Sheet routes (Now Playing) render over the last page; keep both so the sheet can animate out.
  const [base, setBase] = useState<{ m: ScreenMatch; query: Record<string, string> }>(() =>
    isSheet ? { m: HOME, query: {} } : { m: match, query: route.query },
  );
  const [sheet, setSheet] = useState<{ m: ScreenMatch; query: Record<string, string> }>();
  const routeKey = `${route.path}?${new URLSearchParams(route.query).toString()}`;
  useEffect(() => {
    if (isSheet) setSheet({ m: match, query: route.query });
    else setBase({ m: match, query: route.query });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- match/query derive from routeKey
  }, [routeKey]);

  const mainRef = useRef<HTMLElement>(null);
  const pageMatch = isSheet ? base.m : match;
  const basePath = pageMatch.def.path + JSON.stringify(pageMatch.params);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [basePath]);

  // TODO(onboarding): redirect to /welcome while !settings.onboarded.

  if (gated || match.def.presentation === 'bare') {
    const Bare = gated ? resolveScreen('/sign-in').def.screen : match.def.screen;
    return (
      <>
        <Suspense fallback={null}>
          <Bare params={match.params} query={route.query} />
        </Suspense>
        <UpdateNotice />
        <Toaster />
      </>
    );
  }

  const page = isSheet ? base : { m: match, query: route.query };
  const BaseScreen = page.m.def.screen;
  const SheetScreen = sheet?.m.def.screen;
  const nav = pageMatch.def.nav;
  const shellStyle = {
    '--toast-offset': isDesktop
      ? 'calc(var(--playerbar-h) + 16px)'
      : 'calc(var(--tabbar-h) + var(--miniplayer-h) + var(--safe-bottom) + 18px)',
  } as CSSProperties;

  return (
    <div className="aw-app" data-layout={isDesktop ? 'desktop' : 'phone'} style={shellStyle}>
      {isDesktop && <Sidebar active={nav} />}
      <main className="aw-main" ref={mainRef} id="main">
        <Suspense fallback={<PageFallback />}>
          <BaseScreen key={basePath} params={page.m.params} query={page.query} />
        </Suspense>
      </main>
      {isDesktop ? (
        <PlayerBar />
      ) : (
        <>
          <MiniPlayer />
          <TabBar active={nav} />
        </>
      )}
      {SheetScreen && sheet && (
        <Sheet open={isSheet} onClose={() => back('/')} size="full" bare>
          <Suspense fallback={null}>
            <SheetScreen params={sheet.m.params} query={sheet.query} />
          </Suspense>
        </Sheet>
      )}
      <UpdateNotice />
      <Toaster />
    </div>
  );
}
