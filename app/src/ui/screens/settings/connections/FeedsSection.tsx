import { useState } from 'react';
import { CalendarRange, Link2, Newspaper, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { NEWS_REGIONS, feedName, feedsReachable, fetchText, newsRegion } from '@/core/context';
import { useAccountNews } from '@/state/news';
import { useSession } from '@/state/session';
import { useSettings } from '@/state/settings';
import { Button, IconButton, Select, TextField, Toggle, toast } from '../../../components';
import { Hint, SectionCard, errorText } from '../account/parts';

const NEWS_SUGGESTIONS = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
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
                <span className="aw-acct-row__title">{feedName(u)}</span>
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
  const account = useAccountNews();
  const news = connections.news ?? { enabled: true };
  const save = (patch: Partial<NonNullable<typeof connections.news>>) =>
    update({ connections: { ...connections, news: { ...news, enabled: account.enabled, ...patch } } });
  const region = newsRegion(account.region)?.label ?? 'World';
  // re-render on sign-in: a browser on its own cannot read the feeds, the server can
  useSession((x) => x.session);
  const blocked = account.enabled && !account.custom && !feedsReachable();
  return (
    <SectionCard
      id="news"
      icon={Newspaper}
      title="News"
      status={account.enabled ? `${account.feeds.length} feed${account.feeds.length === 1 ? '' : 's'}, ${account.custom ? 'your own list' : `top stories for ${region}`}` : 'Off: the hosts leave the news out'}
      badge={account.enabled ? { label: 'On', tone: 'ok', dot: true } : { label: 'Off', tone: 'neutral' }}
    >
      <Toggle
        label="News on air"
        description="A headline now and then, and one or two in the rundown at the top of the hour."
        checked={account.enabled}
        onChange={(on) => void save({ enabled: on })}
      />
      {account.enabled && (
        <>
          <Select
            label="Headlines from"
            value={account.region}
            options={NEWS_REGIONS.map((r) => ({ value: r.id, label: r.label }))}
            hint={account.custom ? 'Picking a region swaps your list for its top stories.' : news.region ? undefined : 'Picked from your location and language.'}
            onChange={(id) => void save({ region: id, feeds: [] })}
          />
          <FeedList kind="rss" urls={account.feeds} placeholder="https://example.com/feed.xml" suggestions={NEWS_SUGGESTIONS} onChange={(next) => save({ feeds: next })} />
          {account.custom && (
            <div className="aw-acct-chips">
              <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void save({ feeds: [] })}>
                Use the top stories for {region}
              </Button>
            </div>
          )}
        </>
      )}
      {blocked && <Hint>A web browser cannot read news feeds by itself. Sign in and your Host-Caster server fetches the headlines for you; the phone apps read them directly.</Hint>}
      <Hint>Every station plays these unless you give it news feeds of its own. All of them are free, public feeds.</Hint>
    </SectionCard>
  );
}
