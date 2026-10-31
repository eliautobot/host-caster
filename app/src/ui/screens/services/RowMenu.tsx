// "More" button on a service row: opens the shared action menu (popover on desktop, sheet on phones).
import { useRef, useState, type ReactNode } from 'react';
import { Ellipsis } from 'lucide-react';
import { IconButton } from '../../components';
import { ActionMenu, type MenuItem } from '../../library/ActionMenu';

export function RowMenu({ items, header, label = 'More' }: { items: MenuItem[]; header?: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={btn} icon={Ellipsis} label={label} size="sm" onClick={() => setOpen(true)} />
      <ActionMenu open={open} onClose={() => setOpen(false)} anchor={btn.current} items={items} header={header} label={label} />
    </>
  );
}

export type { MenuItem };
