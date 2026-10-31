// Component gallery for design work: #/dev/components (not in the nav).
import { useState } from 'react';
import { Heart, Mic, Play, Plus, Search, Settings2, Shuffle, Trash2 } from 'lucide-react';
import { useHosts } from '@/state/hosts';
import {
  Artwork,
  Avatar,
  AvatarStack,
  Badge,
  Button,
  Card,
  Chip,
  EmptyState,
  IconButton,
  List,
  ListRow,
  OnAirBadge,
  SectionHeader,
  Select,
  Sheet,
  Skeleton,
  SkeletonText,
  Slider,
  StationArt,
  Tabs,
  TextArea,
  TextField,
  Toggle,
  toast,
  AVATAR_PALETTE_KEYS,
} from '../components';
import { Page } from '../layout/Page';
import type { ScreenProps } from '.';

const row = { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } as const;
const stack = { display: 'grid', gap: 16 } as const;

export default function DevComponents(_: ScreenProps) {
  const hosts = useHosts((s) => s.hosts);
  const [on, setOn] = useState(true);
  const [vol, setVol] = useState(0.6);
  const [tab, setTab] = useState('songs');
  const [seg, setSeg] = useState('dark');
  const [sel, setSel] = useState('normal');
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(false);

  return (
    <Page title="Components" subtitle="Host-Caster design system" back="/">
      <div style={stack}>
        <SectionHeader title="Buttons" />
        <div style={row}>
          <Button variant="primary" icon={Play}>Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="accent" icon={Mic}>Accent</Button>
          <Button variant="danger" icon={Trash2}>Delete</Button>
          <Button variant="icon" icon={Plus} aria-label="Add" />
          <Button variant="primary" loading>Saving</Button>
          <Button size="sm">Small</Button>
          <Button size="lg" variant="primary">Large</Button>
        </div>
        <div style={row}>
          <IconButton icon={Shuffle} label="Shuffle" />
          <IconButton icon={Shuffle} label="Shuffle on" active />
          <IconButton icon={Heart} label="Like" variant="solid" />
          <IconButton icon={Play} label="Play" variant="primary" size="lg" iconProps={{ fill: 'currentColor', strokeWidth: 0 }} />
          <IconButton icon={Mic} label="Talk" variant="accent" size="lg" />
        </div>

        <SectionHeader title="Badges" />
        <div style={row}>
          <OnAirBadge onAir />
          <OnAirBadge onAir={false} />
          <Badge tone="accent" dot="live">Live</Badge>
          <Badge tone="warm">New</Badge>
          <Badge tone="ok" dot>Connected</Badge>
          <Badge tone="danger">Error</Badge>
          <Badge>88.1 FM</Badge>
        </div>

        <SectionHeader title="Avatars and art" />
        <div style={row}>
          {hosts.map((h, i) => (
            <Avatar key={h.id} avatar={h.avatar} name={h.name} size={56} speaking={i === 0} />
          ))}
          <Avatar name="Sunny" size={56} avatar={{ kind: 'emoji', value: '☀️', color: 'amber' }} />
          <AvatarStack people={hosts} size={32} />
          <StationArt color="#ff5a36" frequency="88.1" size={64} radius={14} />
          <StationArt color="#ffb020" frequency="101.3" size={64} radius={14} />
          <Artwork size={64} radius={10} />
        </div>
        <div style={row}>
          {AVATAR_PALETTE_KEYS.map((k) => (
            <Avatar key={k} name={k} size={40} avatar={{ kind: 'monogram', value: k[0]!.toUpperCase(), color: k }} />
          ))}
        </div>

        <SectionHeader title="Inputs" />
        <Card>
          <div style={{ ...stack, maxWidth: 520 }}>
            <TextField label="Host name" placeholder="Maya" hint="Shown on air and in the app." />
            <TextField label="Search" icon={Search} placeholder="Songs, artists" />
            <TextField label="Server URL" defaultValue="htp:/oops" error="That does not look like a URL." />
            <TextArea label="Personality" autoResize value={text} onChange={setText} placeholder="Who are they?" />
            <Select
              label="Talk length"
              value={sel}
              onChange={setSel}
              options={[
                { value: 'short', label: 'Short (1-2 lines)' },
                { value: 'normal', label: 'Normal (3-4 lines)' },
                { value: 'long', label: 'Long (5-8 lines)' },
              ]}
            />
            <Toggle checked={on} onChange={setOn} label="Talk over intros" description="Hosts speak while the next song starts." />
            <Slider label="Music under voice" showLabel thumb value={vol} onChange={setVol} format={(v) => `${Math.round(v * 100)}%`} />
          </div>
        </Card>

        <SectionHeader title="Tabs and chips" />
        <Tabs
          items={[
            { value: 'songs', label: 'Songs' },
            { value: 'albums', label: 'Albums' },
            { value: 'artists', label: 'Artists' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <Tabs
          variant="segmented"
          items={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
          value={seg}
          onChange={setSeg}
        />
        <Tabs
          variant="underline"
          items={[
            { value: 'songs', label: 'Personality' },
            { value: 'albums', label: 'Voice' },
            { value: 'artists', label: 'Brain' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <div style={row}>
          <Chip selected>Weather</Chip>
          <Chip onClick={() => undefined}>News</Chip>
          <Chip onRemove={() => undefined}>jazz</Chip>
          <Chip size="sm">small</Chip>
        </div>

        <SectionHeader title="Lists" />
        <List card>
          <ListRow leading={Settings2} title="Brains" subtitle="AI models your hosts think with" chevron to="/settings/brains" />
          <ListRow leading={<Artwork size={44} />} title="Song title" subtitle="Artist" trailing="3:41" onClick={() => undefined} />
          <ListRow leading={<Toggle checked={on} onChange={setOn} aria-label="On" />} title="Static row" />
        </List>

        <SectionHeader title="Feedback" />
        <div style={row}>
          <Button onClick={() => toast('Saved to your library')}>Toast</Button>
          <Button onClick={() => toast.success('Host saved', 'Maya is ready for the next break.')}>Success</Button>
          <Button onClick={() => toast.error('Could not reach the model', 'Check the URL in Brains.')}>Error</Button>
          <Button onClick={() => toast({ title: 'Station deleted', action: { label: 'Undo', onClick: () => undefined } })}>
            With action
          </Button>
          <Button variant="primary" onClick={() => setSheet(true)}>Open sheet</Button>
        </div>
        <Card>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
            <Skeleton circle width={48} height={48} />
            <div style={{ flex: 1 }}>
              <SkeletonText lines={2} />
            </div>
          </div>
        </Card>
        <EmptyState card icon={Search} title="Nothing found" description="Try another search." />
      </div>

      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title="Talk to the hosts"
        description="Your message breaks in after this song."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheet(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => setSheet(false)}>Send</Button>
          </>
        }
      >
        <TextArea label="Message" placeholder="Play something for my run" data-autofocus />
      </Sheet>
    </Page>
  );
}
