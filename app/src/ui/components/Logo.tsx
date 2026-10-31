import { cx } from './cx';

/** The Host-Caster mark: broadcast arcs around the on-air dot. Arcs follow currentColor. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="64 64 384 384"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="30" strokeLinecap="round">
        <path d="M190.95 190.95 A92 92 0 0 0 190.95 321.05" />
        <path d="M321.05 190.95 A92 92 0 0 1 321.05 321.05" />
        <path d="M142.86 142.86 A160 160 0 0 0 142.86 369.14" opacity="0.5" />
        <path d="M369.14 142.86 A160 160 0 0 1 369.14 369.14" opacity="0.5" />
      </g>
      <circle cx="256" cy="256" r="36" fill="var(--accent, #ff5a36)" />
    </svg>
  );
}

export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cx('aw-logo', className)} style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.36 }}>
      <LogoMark size={size} />
      <span
        style={{
          fontSize: size * 0.72,
          fontWeight: 680,
          letterSpacing: '-0.035em',
          lineHeight: 1,
        }}
      >
        Host-Caster
      </span>
    </span>
  );
}
