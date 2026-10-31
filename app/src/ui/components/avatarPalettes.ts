// Host avatar gradients. Warm and neutral only (no purple, no blue).
export const AVATAR_PALETTES = {
  sunrise: ['#ffc06a', '#ff5a36'],
  ember: ['#ff8a4c', '#c4321a'],
  amber: ['#ffe08a', '#f29b0c'],
  coral: ['#ffa48a', '#e0483c'],
  clay: ['#e2a77a', '#93502e'],
  sand: ['#efdcbc', '#b38e62'],
  olive: ['#c9bb72', '#6d6431'],
  dusk: ['#8a817a', '#2b2724'],
  slate: ['#b4b4bb', '#55555d'],
  graphite: ['#4a4a52', '#161618'],
} as const satisfies Record<string, readonly [string, string]>;

export type AvatarPalette = keyof typeof AVATAR_PALETTES;

export const AVATAR_PALETTE_KEYS = Object.keys(AVATAR_PALETTES) as AvatarPalette[];

/** Palette key or hex colour -> [from, to]. */
export function paletteColors(color: string | undefined): readonly [string, string] {
  if (color && color in AVATAR_PALETTES) return AVATAR_PALETTES[color as AvatarPalette];
  if (color && /^#[0-9a-f]{3,8}$/i.test(color)) return [`color-mix(in srgb, ${color} 55%, #fff)`, color];
  return AVATAR_PALETTES.slate;
}

/** Stable palette for a name (new hosts, the listener). */
export function paletteFor(seed: string): AvatarPalette {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_PALETTE_KEYS[h % AVATAR_PALETTE_KEYS.length]!;
}
