// Terms and privacy, one tap away in the app: the hosted service's own pages, and YouTube's Terms of Service plus the
// Google Privacy Policy (YouTube API Services policies III.A: the app links them and users agree to them).
import type { MouseEvent, ReactNode } from 'react';
import { isOnline } from '@/core/api';
import { isNative, openExternal } from '@/core/native';

const SITE = (import.meta.env.VITE_HOSTCASTER_SITE ?? 'https://host-caster.com').trim().replace(/\/+$/, '');

export const LEGAL_URLS = {
  terms: `${SITE}/terms`,
  privacy: `${SITE}/privacy`,
  youtubeTerms: 'https://www.youtube.com/t/terms',
  googlePrivacy: 'http://www.google.com/policies/privacy',
} as const;

/** An outside page: the system browser in the phone apps, a new tab on the web. */
export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  const open = (e: MouseEvent) => {
    if (!isNative) return;
    e.preventDefault();
    void openExternal(href);
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="aw-textlink" onClick={open}>
      {children}
    </a>
  );
}

/** Sign-in fine print: what signing in agrees to. */
export function SignInAgreement() {
  return (
    <p className="aw-bare__fine" data-legal-agree>
      By continuing you agree to the <ExtLink href={LEGAL_URLS.terms}>Terms</ExtLink> and the <ExtLink href={LEGAL_URLS.privacy}>Privacy Policy</ExtLink>.
      YouTube songs play in YouTube’s player under the <ExtLink href={LEGAL_URLS.youtubeTerms}>YouTube Terms of Service</ExtLink>.
    </p>
  );
}

/** Settings footer: the service's terms and privacy (hosted service only) and YouTube's (every edition). */
export function LegalLinks({ className }: { className?: string }) {
  const hosted = isOnline();
  return (
    <p className={className} data-legal-links>
      {hosted && (
        <>
          <ExtLink href={LEGAL_URLS.terms}>Terms</ExtLink>
          {' · '}
          <ExtLink href={LEGAL_URLS.privacy}>Privacy Policy</ExtLink>
          {' · '}
        </>
      )}
      <ExtLink href={LEGAL_URLS.youtubeTerms}>YouTube Terms of Service</ExtLink>
      {' · '}
      <ExtLink href={LEGAL_URLS.googlePrivacy}>Google Privacy Policy</ExtLink>
    </p>
  );
}
