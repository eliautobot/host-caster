import { useRef } from 'react';
import { ImageUp } from 'lucide-react';
import type { HostAvatar } from '@/core/types';
import { AVATAR_PALETTE_KEYS, AVATAR_PALETTES, Avatar, Button, Tabs, TextField, toast } from '../../components';
import { Swatches } from '../form';
import './host.css';

const EMOJIS = ['☀️', '🌙', '🎧', '📻', '🎙️', '🎸', '🎹', '🥁', '🎷', '🌊', '🌿', '🔥', '⚡', '🏆', '🎭', '🦊', '🐻', '🦉', '🐙', '🍊', '☕', '🌵', '🚀', '✨'];

/** Downscales a picked photo to a 256 px JPEG data URL (small enough to sync, works offline). */
async function photoToDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not read the photo');
  const s = Math.min(bmp.width, bmp.height);
  ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export function AvatarEditor({ avatar, name, onChange }: { avatar: HostAvatar; name: string; onChange: (a: HostAvatar) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const kind = avatar.kind;
  const setKind = (k: HostAvatar['kind']) => {
    if (k === kind) return;
    if (k === 'emoji') onChange({ ...avatar, kind: k, value: EMOJIS[0]! });
    else if (k === 'monogram') onChange({ ...avatar, kind: k, value: name.trim().slice(0, 1).toUpperCase() });
    else file.current?.click();
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      onChange({ ...avatar, kind: 'image', value: await photoToDataUrl(f) });
    } catch (err) {
      toast.error('Could not use that photo', err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="aw-avedit">
      <div className="aw-avedit__preview">
        <Avatar avatar={avatar} name={name || 'Host'} size={96} />
      </div>
      <div className="aw-avedit__controls">
        <Tabs
          variant="segmented"
          label="Avatar type"
          value={kind}
          onChange={setKind}
          items={[
            { value: 'monogram', label: 'Letters' },
            { value: 'emoji', label: 'Emoji' },
            { value: 'image', label: 'Photo' },
          ]}
        />
        {kind === 'monogram' && (
          <TextField label="Letters" value={avatar.value} maxLength={2} placeholder={name.slice(0, 1).toUpperCase()} onChange={(v) => onChange({ ...avatar, value: v.toUpperCase() })} />
        )}
        {kind === 'emoji' && (
          <div className="aw-emojis" role="radiogroup" aria-label="Emoji">
            {EMOJIS.map((e) => (
              <button key={e} type="button" role="radio" aria-checked={avatar.value === e} className="aw-emoji" onClick={() => onChange({ ...avatar, value: e })}>
                {e}
              </button>
            ))}
          </div>
        )}
        {kind === 'image' && (
          <Button size="sm" icon={ImageUp} onClick={() => file.current?.click()}>
            Choose another photo
          </Button>
        )}
        {kind !== 'image' && (
          <Swatches
            label="Colour"
            value={avatar.color}
            onChange={(color) => onChange({ ...avatar, color })}
            options={AVATAR_PALETTE_KEYS.map((k) => ({ value: k, label: k, css: `linear-gradient(140deg, ${AVATAR_PALETTES[k][0]}, ${AVATAR_PALETTES[k][1]})` }))}
          />
        )}
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
    </div>
  );
}
