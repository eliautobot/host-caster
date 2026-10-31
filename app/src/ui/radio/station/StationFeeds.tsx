// News feeds of a station: RSS/Atom URLs the hosts read headlines from.
import { useState } from 'react';
import { Newspaper, Plus, X } from 'lucide-react';
import { fetchText, parseFeed } from '@/core/context';
import { Button, Chip, IconButton, TextField } from '../../components';
import { StatusLine } from '../form';
import './station.css';

/** Well-known public feeds, offered as one-tap suggestions. */
const SUGGESTED: { label: string; url: string }[] = [
  { label: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { label: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
  { label: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  { label: 'Pitchfork', url: 'https://pitchfork.com/feed/feed-news/rss' },
  { label: 'ESPN', url: 'https://www.espn.com/espn/rss/news' },
];

function host(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function StationFeeds({ feeds, onChange, newsOn }: { feeds: string[]; onChange: (f: string[]) => void; newsOn: boolean }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string }>();

  const add = async (raw: string) => {
    let url = raw.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    if (feeds.includes(url)) return setStatus({ tone: 'error', text: 'That feed is already on the station.' });
    setBusy(true);
    setStatus(undefined);
    try {
      const items = parseFeed(await fetchText(url), host(url));
      if (!items.length) throw new Error('No headlines found at that address. Is it an RSS or Atom feed?');
      onChange([...feeds, url].slice(0, 6));
      setDraft('');
      setStatus({ tone: 'ok', text: `Added. Latest: “${items[0]!.title}”` });
    } catch (err) {
      setStatus({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const open = SUGGESTED.filter((s) => !feeds.includes(s.url));
  return (
    <div className="aw-feeds">
      {feeds.map((f) => (
        <div key={f} className="aw-entry">
          <span className="aw-preset__icon">
            <Newspaper aria-hidden />
          </span>
          <div className="aw-entry__text">
            <p className="aw-entry__title aw-truncate">{host(f)}</p>
            <p className="aw-entry__meta aw-truncate">{f}</p>
          </div>
          <IconButton icon={X} size="sm" label={`Remove ${host(f)}`} onClick={() => onChange(feeds.filter((x) => x !== f))} />
        </div>
      ))}
      {feeds.length < 6 && (
        <div className="aw-modelrow">
          <TextField
            label="Add a feed"
            value={draft}
            inputMode="url"
            placeholder="https://example.com/feed.xml"
            onChange={setDraft}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void add(draft);
              }
            }}
          />
          <Button icon={Plus} loading={busy} disabled={!draft.trim()} onClick={() => void add(draft)}>
            Add
          </Button>
        </div>
      )}
      {open.length > 0 && feeds.length < 6 && (
        <div className="aw-hstack">
          {open.map((s) => (
            <Chip key={s.url} size="sm" icon={Plus} onClick={() => void add(s.url)}>
              {s.label}
            </Chip>
          ))}
        </div>
      )}
      {status && <StatusLine tone={status.tone}>{status.text}</StatusLine>}
      {!newsOn && feeds.length > 0 && <p className="aw-field__hint">Turn on News under “What they talk about” to hear these.</p>}
    </div>
  );
}
