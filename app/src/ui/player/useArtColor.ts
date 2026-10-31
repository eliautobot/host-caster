// A soft, vivid color picked from a cover (for blurred backdrops and tints). Cached per artwork id.
import { useEffect, useState } from 'react';
import { artworkUrl } from '@/core/services/artwork';

const cache = new Map<string, string | null>();

async function pick(artworkId: string): Promise<string | null> {
  const url = await artworkUrl(artworkId);
  if (!url) return null;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, size, size);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null; // cross-origin cover without CORS
  }
  // weight saturated, mid-bright pixels; skip near-black/near-white
  let r = 0;
  let g = 0;
  let b = 0;
  let w = 0;
  for (let i = 0; i < data.length; i += 4) {
    const R = data[i]!;
    const G = data[i + 1]!;
    const B = data[i + 2]!;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const light = (max + min) / 510;
    if (light < 0.08 || light > 0.92) continue;
    const sat = max === 0 ? 0 : (max - min) / max;
    const weight = 0.15 + sat * sat * 3;
    r += R * weight;
    g += G * weight;
    b += B * weight;
    w += weight;
  }
  if (!w) return null;
  return toneDown(r / w, g / w, b / w);
}

/** keep it rich but not neon: cap lightness, lift very dark colors */
function toneDown(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b);
  const scale = max > 200 ? 200 / max : max < 90 && max > 0 ? 90 / max : 1;
  const c = (x: number) => Math.round(Math.min(255, x * scale));
  return `rgb(${c(r)} ${c(g)} ${c(b)})`;
}

export function useArtColor(artworkId: string | undefined, fallback: string): string {
  const [color, setColor] = useState<string | null | undefined>(artworkId ? cache.get(artworkId) : null);
  useEffect(() => {
    if (!artworkId) {
      setColor(null);
      return;
    }
    if (cache.has(artworkId)) {
      setColor(cache.get(artworkId));
      return;
    }
    let live = true;
    void pick(artworkId)
      .catch(() => null)
      .then((c) => {
        cache.set(artworkId, c);
        if (live) setColor(c);
      });
    return () => {
      live = false;
    };
  }, [artworkId]);
  return color ?? fallback;
}

/** Resolved URL for an artwork id (blob, server cover or remote URL). */
export function useArtworkUrl(artworkId: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    if (!artworkId) setUrl(undefined);
    else void artworkUrl(artworkId).then((u) => live && setUrl(u), () => live && setUrl(undefined));
    return () => {
      live = false;
    };
  }, [artworkId]);
  return url;
}
