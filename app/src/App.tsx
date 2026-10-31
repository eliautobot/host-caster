import { AppShell } from './ui/layout/AppShell';

export function App() {
  return <AppShell />;
}

/** Shown when IndexedDB cannot open (private mode on old browsers, storage blocked). */
export function BootError({ error }: { error: unknown }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24, textAlign: 'center' }}>
      <div style={{ maxWidth: 420 }}>
        <h1 style={{ fontSize: 24 }}>Host-Caster could not start</h1>
        <p style={{ color: 'var(--text-2)', marginTop: 8 }}>
          This browser blocked local storage. Try a normal (not private) window, or allow site data.
        </p>
        <pre style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 16, whiteSpace: 'pre-wrap' }}>{String(error)}</pre>
      </div>
    </div>
  );
}
