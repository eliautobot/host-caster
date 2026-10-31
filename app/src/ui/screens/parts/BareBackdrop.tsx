/** Concentric broadcast rings + a warm glow, centered on the logo mark (render inside .aw-bare__mark). */
export function BareBackdrop() {
  return (
    <svg className="aw-bare__waves" viewBox="0 0 1200 1200" fill="none" aria-hidden>
      <defs>
        <radialGradient id="aw-bare-glow">
          <stop offset="0" stopColor="#ff5a36" stopOpacity="0.2" />
          <stop offset="0.45" stopColor="#ff5a36" stopOpacity="0.06" />
          <stop offset="1" stopColor="#ff5a36" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="600" cy="600" r="420" fill="url(#aw-bare-glow)" />
      {[110, 190, 280, 380, 490].map((r, i) => (
        <circle key={r} cx="600" cy="600" r={r} stroke="var(--text)" strokeOpacity={0.075 - i * 0.013} strokeWidth="1.5" />
      ))}
    </svg>
  );
}
