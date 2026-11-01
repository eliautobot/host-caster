// The page picker for the Notion card: which shared pages the hosts may read (up to 5), or the one page they write to.
import { useEffect, useState } from 'react';
import { Check, Database, FileText, RefreshCw, Search } from 'lucide-react';
import { notion, type NotionItemType, type NotionPickerItem } from '@/core/api/notion';
import { Button, Sheet, Skeleton, TextField, Toggle, cx } from '../../../components';
import { errorText, useLoad } from '../account/parts';

const MAX_READ = 5;

export type PickerResult =
  | { mode: 'read'; items: { id: string; type: NotionItemType }[] }
  | { mode: 'write'; id: string; writeMode: 'new' | 'direct' };

export function NotionPicker({
  open,
  mode,
  selected,
  newPage,
  onClose,
  onSave,
  onShareMore,
}: {
  open: boolean;
  mode: 'read' | 'write';
  /** ids picked now (read) or the page written to / its parent (write) */
  selected: string[];
  /** write: make a Host-Caster page inside the chosen one */
  newPage: boolean;
  onClose: () => void;
  onSave: (r: PickerResult) => Promise<unknown>;
  onShareMore: () => void;
}) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>(selected);
  const [inside, setInside] = useState(newPage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const list = useLoad(() => (open ? notion.pages(query) : Promise.resolve({ items: [] as NotionPickerItem[] })), [open, query]);

  useEffect(() => {
    if (!open) return;
    setPicked(selected);
    setInside(newPage);
    setError(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // search as you type, a moment after the last key
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const items = (list.data?.items ?? []).filter((i) => mode === 'read' || i.type === 'page');
  const toggle = (id: string) => {
    if (mode === 'write') return setPicked([id]);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_READ ? p : [...p, id]));
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const byId = new Map(items.map((i) => [i.id, i]));
      if (mode === 'read') {
        await onSave({ mode: 'read', items: picked.map((id) => ({ id, type: byId.get(id)?.type ?? 'page' })) });
      } else if (picked[0]) {
        await onSave({ mode: 'write', id: picked[0], writeMode: inside ? 'new' : 'direct' });
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title={mode === 'read' ? 'Pages your hosts can read' : 'Where your hosts write'}
      description={
        mode === 'read'
          ? `Pick up to ${MAX_READ}. Your hosts mention open to-dos, headings and recent changes from them.`
          : 'Pick one page. Your hosts only add their own notes there and never change what you wrote.'
      }
      footer={
        <div className="aw-acct-sheet-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void save()} disabled={mode === 'write' && !picked[0]}>
            Save
          </Button>
        </div>
      }
    >
      <div className="aw-notion-picker">
        <TextField aria-label="Search your shared pages" placeholder="Search shared pages" icon={Search} value={q} onChange={setQ} />
        {list.loading && !list.data ? (
          <div className="aw-notion-picker__list" aria-busy>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={52} />
            ))}
          </div>
        ) : list.error ? (
          <p className="aw-notion-empty">{errorText(list.error)}</p>
        ) : items.length ? (
          <div className="aw-notion-picker__list" role={mode === 'read' ? 'group' : 'radiogroup'} aria-label="Shared pages">
            {items.map((i) => {
              const on = picked.includes(i.id);
              const Icon = i.type === 'data_source' ? Database : FileText;
              return (
                <button
                  key={i.id}
                  type="button"
                  role={mode === 'read' ? 'checkbox' : 'radio'}
                  aria-checked={on}
                  className={cx('aw-notion-item', on && 'aw-notion-item--on')}
                  onClick={() => toggle(i.id)}
                  disabled={mode === 'read' && !on && picked.length >= MAX_READ}
                >
                  <span className="aw-acct-row__icon" aria-hidden>
                    {i.icon ? <span className="aw-notion-emoji">{i.icon}</span> : <Icon />}
                  </span>
                  <span className="aw-acct-row__text">
                    <span className="aw-acct-row__title">{i.title}</span>
                    <span className="aw-acct-row__sub">
                      {i.type === 'data_source' ? 'Database' : 'Page'}
                      {i.edited ? ` · edited ${i.edited}` : ''}
                    </span>
                  </span>
                  <span className={cx('aw-notion-check', mode === 'write' && 'aw-notion-check--round')} aria-hidden>
                    {on && <Check />}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="aw-notion-empty">
            {query ? 'Nothing shared matches that.' : 'Nothing is shared with Host-Caster yet.'} Choose more pages on Notion, then come back.
          </p>
        )}
        {mode === 'write' && (
          <Toggle
            label="Make a Host-Caster page inside it"
            description="Recommended. Your hosts keep their notes on their own page, so yours stay as they are."
            checked={inside}
            onChange={setInside}
          />
        )}
        <div className="aw-acct-actions">
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onShareMore}>
            Share more pages on Notion
          </Button>
        </div>
        {error && <p className="aw-notion-error">{error}</p>}
      </div>
    </Sheet>
  );
}
