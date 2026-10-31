import { useState } from 'react';
import { CalendarRange, Link2, Newspaper, Plus, Trash2 } from 'lucide-react';
import { fetchText } from '@/core/context';
import { useSettings } from '@/state/settings';
import { Button, IconButton, TextField, Toggle, toast } from '../../../components';
import { Hint, SectionCard, errorText } from '../account/parts';

const NEWS_SUGGESTIONS = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
];

function cleanUrl(input: string): string {
  const raw = input.trim().replace(/^webcals?:\/\//i, 'https://');
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  return url.href;
}

/** Fetches the feed once (through the server when signed in) to make sure it is what it claims to be. */
async function verify(kind: 'ics' | 'rss', url: string): Promise<void> {
  const text = await fetchText(url);
  const ok = kind === 'ics' ? /BEGIN:VCALENDAR/i.test(text) : /<(rss|feed|rdf:RDF)[\s>]/i.test(text);
  if (!ok) throw new Error(kind === 'ics' ? 'That link is not an ICS calendar.' : 'That link is not an RSS or Atom feed.');
}

function FeedList({
  kind,
  urls,
  onChange,
  placeholder,
  suggestions = [],
}: {
  kind: 'ics' | 'rss';
  urls: string[];
  onChange: (urls: string[]) => Promise<unknown>;
  placeholder: string;
  suggestions?: { name: string; url: string }[];
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async (input: string) => {
    setError(undefined);
    let url: string;
    try {
      url = cleanUrl(input);
    } catch {
      setError('Enter a full link, starting with https://');
      return;
    }
    if (urls.includes(url)) {
      setValue('');
      return;
    }
    setBusy(true);
    try {
      await verify(kind, url);
      await onChange([...urls, url]);
      setValue('');
      toast.success(kind === 'ics' ? 'Calendar added' : 'Feed added');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const left = suggestions.filter((s) => !urls.includes(s.url));
  return (
    <div className="aw-acct-form">
      {urls.length > 0 && (
        <div className="aw-acct-rows">
          {urls.map((u) => (
            <div key={u} className="aw-acct-row">
              <span className="aw-acct-row__icon">
                <Link2 aria-hidden />
              </span>
              <span className="aw-acct-row__text">
                <span className="aw-acct-row__title">{new URL(u).hostname.replace(/^www\./, '')}</span>
                <span className="aw-acct-row__sub aw-acct-url">{u}</span>
              </span>
              <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => void onChange(urls.filter((x) => x !== u))} />
            </div>
          ))}
        </div>
      )}
      <form
        className="aw-acct-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void add(value);
        }}
      >
        <TextField
          aria-label={kind === 'ics' ? 'Calendar link' : 'Feed link'}
          placeholder={placeholder}
          value={value}
          onChange={setValue}
          inputMode="url"
          autoCapitalize="off"
          spellCheck={false}
          error={error}
        />
        <Button type="submit" icon={Plus} loading={busy} disabled={!value.trim()}>
          Add
        </Button>
      </form>
      {left.length > 0 && (
        <div className="aw-acct-chips">
          {left.map((s) => (
            <Button key={s.url} size="sm" variant="ghost" icon={Plus} onClick={() => void add(s.url)}>
              {s.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CalendarFeedsSection() {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const urls = connections.calendar?.icsUrls ?? [];
  return (
    <SectionCard icon={CalendarRange} title="Calendar links (ICS)" status={urls.length ? `${urls.length} calendar${urls.length === 1 ? '' : 's'}` : 'Any calendar that has a share link'}>
      <FeedList
        kind="ics"
        urls={urls}
        placeholder="https://… .ics or webcal://…"
        onChange={(next) => update({ connections: { ...connections, calendar: { google: connections.calendar?.google ?? false, icsUrls: next } } })}
      />
      <Hint>
        Outlook, iCloud, Proton, Fastmail and Google all offer a secret ICS link in their calendar sharing settings. Anyone with the link can read
        the calendar, so keep it to yourself.
      </Hint>
    </SectionCard>
  );
}

export function NewsFeedsSection() {
  const connections = useSettings((s) => s.settings.connections);
  const update = useSettings((s) => s.update);
  const news = connections.news ?? { enabled: true };
  const feeds = news.feeds ?? [];
  const enabled = news.enabled !== false;
  return (
    <SectionCard icon={Newspaper} title="News feeds (RSS)" status={feeds.length ? `${feeds.length} feed${feeds.length === 1 ? '' : 's'}` : 'Headlines for the hosts to bring up'}>
      <Toggle
        label="News on air"
        description="Hosts mention a headline now and then on stations with news on."
        checked={enabled}
        onChange={(on) => void update({ connections: { ...connections, news: { ...news, enabled: on } } })}
      />
      <FeedList
        kind="rss"
        urls={feeds}
        placeholder="https://example.com/feed.xml"
        suggestions={NEWS_SUGGESTIONS}
        onChange={(next) => update({ connections: { ...connections, news: { ...news, enabled, feeds: next } } })}
      />
      <Hint>These feeds play on every station. Each station can add its own in its settings.</Hint>
    </SectionCard>
  );
}
