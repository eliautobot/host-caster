import { useEffect } from 'react';
import { create } from 'zustand';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { IconButton } from './Button';
import { cx } from './cx';
import './Toast.css';

export type ToastTone = 'default' | 'success' | 'error';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms; 0 = until dismissed */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  leaving?: boolean;
}

const useToasts = create<{ items: ToastItem[] }>(() => ({ items: [] }));
let seq = 0;

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), 200);
}

/** Dismisses the toast when called; update() changes it in place (progress). */
export interface ToastHandle {
  (): void;
  update(patch: Partial<ToastOptions>): void;
}

/** Show a toast from anywhere (no hook needed). Returns a dismiss function (with update). */
export function toast(opts: ToastOptions | string): ToastHandle {
  const o = typeof opts === 'string' ? { title: opts } : opts;
  const id = ++seq;
  useToasts.setState((s) => ({ items: [...s.items.slice(-2), { ...o, id }] }));
  const handle = () => dismiss(id);
  handle.update = (patch: Partial<ToastOptions>) =>
    useToasts.setState((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  return handle;
}

toast.success = (title: string, description?: string) => toast({ title, description, tone: 'success' });
toast.error = (title: string, description?: string) => toast({ title, description, tone: 'error' });

const ICONS = { default: Info, success: CircleCheck, error: CircleAlert } as const;

function ToastView({ item }: { item: ToastItem }) {
  const tone = item.tone ?? 'default';
  const Icon = ICONS[tone];
  useEffect(() => {
    const ms = item.duration ?? (tone === 'error' ? 6000 : 4000);
    if (!ms) return;
    const t = setTimeout(() => dismiss(item.id), ms);
    return () => clearTimeout(t);
  }, [item.id, item.duration, tone]);
  return (
    <div
      className={cx('aw-toast', `aw-toast--${tone}`)}
      role={tone === 'error' ? 'alert' : 'status'}
      data-leaving={item.leaving || undefined}
    >
      <Icon className="aw-toast__icon" aria-hidden />
      <div className="aw-toast__body">
        <p className="aw-toast__title">{item.title}</p>
        {item.description && <p className="aw-toast__desc">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          className="aw-toast__action"
          onClick={() => {
            item.action?.onClick();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <IconButton icon={X} label="Dismiss" size="sm" onClick={() => dismiss(item.id)} />
    </div>
  );
}

/** Mount once (AppShell). */
export function Toaster() {
  const items = useToasts((s) => s.items);
  return (
    <div className="aw-toaster" aria-live="polite">
      {items.map((t) => (
        <ToastView key={t.id} item={t} />
      ))}
    </div>
  );
}
