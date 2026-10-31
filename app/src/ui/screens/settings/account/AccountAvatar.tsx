// The signed-in account's picture (Google / X photo) with a monogram fallback when there is none or it fails to load.
import { useState, type CSSProperties } from 'react';
import { Avatar } from '../../../components';

export function AccountAvatar({ name, url, size = 40 }: { name: string; url?: string; size?: number }) {
  const [failed, setFailed] = useState<string>();
  if (!url || failed === url) return <Avatar name={name || '?'} size={size} avatar={{ kind: 'monogram', value: '', color: 'graphite' }} />;
  return (
    <span className="aw-avatar aw-avatar--image" style={{ '--size': `${size}px` } as CSSProperties}>
      <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setFailed(url)} />
    </span>
  );
}
