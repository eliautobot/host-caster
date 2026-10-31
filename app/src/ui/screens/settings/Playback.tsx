import { useState } from 'react';
import { ArrowLeft, ArrowRight, Blend, Keyboard } from 'lucide-react';
import { player } from '@/core/player';
import { Slider, Toggle } from '../../components';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { Hint, SectionCard } from './account/parts';
import './account/account.css';
import './Playback.css';

const SHORTCUTS: [keys: string[], what: string][] = [
  [['Space'], 'Play or pause'],
  [['Shift', '→'], 'Next song (skips a break)'],
  [['Shift', '←'], 'Previous song'],
  [['←', '→'], 'Back or forward 10 seconds'],
  [['+', '−'], 'Volume up or down'],
  [['M'], 'Mute'],
  [['S'], 'Shuffle'],
  [['R'], 'Repeat'],
  [['Shift', 'L'], 'Like the song'],
  [['Q'], 'Up next'],
];

/** Settings -> Playback (owner: player agent): crossfade, keyboard shortcuts. */
export default function Playback() {
  const desktop = useIsDesktop();
  const [fade, setFade] = useState(() => player.crossfade);
  const [lastOn, setLastOn] = useState(() => player.crossfade || 6000);
  const set = (ms: number) => {
    setFade(ms);
    if (ms > 0) setLastOn(ms);
    player.setCrossfade(ms);
  };

  return (
    <div className="aw-playback">
      <SectionCard icon={Blend} tone="warm" title="Crossfade" status="Blend the end of a song into the next one.">
        <Toggle
          label="Crossfade songs"
          description="Songs from this device and your server. Host breaks always wait for the song to end."
          checked={fade > 0}
          onChange={(on) => set(on ? lastOn : 0)}
        />
        {fade > 0 && (
          <Slider
            className="aw-playback__fade"
            label="Fade length"
            showLabel
            thumb
            min={1000}
            max={12_000}
            step={500}
            value={fade}
            format={(v) => `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`}
            onChange={setFade}
            onCommit={set}
          />
        )}
      </SectionCard>

      {desktop && (
        <SectionCard icon={Keyboard} title="Keyboard shortcuts" status="Work anywhere in the app, except while you type.">
          <dl className="aw-keys">
            {SHORTCUTS.map(([keys, what]) => (
              <div className="aw-keys__row" key={what}>
                <dt>
                  {keys.map((k) => (
                    <kbd key={k} aria-label={k === '←' ? 'Left arrow' : k === '→' ? 'Right arrow' : undefined}>
                      {k === '←' ? <ArrowLeft aria-hidden /> : k === '→' ? <ArrowRight aria-hidden /> : k}
                    </kbd>
                  ))}
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <Hint>Media keys on your keyboard and headphones work too.</Hint>
        </SectionCard>
      )}
    </div>
  );
}
