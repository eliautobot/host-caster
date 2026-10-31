import { isNotImplemented } from '@/core/util/errors';
import { toast } from './components/Toast';

/** Runs a UI action; turns failures (and not-built-yet stubs) into toasts. */
export async function runAction(fn: () => unknown, opts: { success?: string } = {}): Promise<boolean> {
  try {
    await fn();
    if (opts.success) toast.success(opts.success);
    return true;
  } catch (err) {
    if (isNotImplemented(err)) {
      toast({ title: `${err.feature} is coming soon`, description: 'This part of Host-Caster is still being built.' });
    } else {
      console.error(err);
      toast.error('Something went wrong', err instanceof Error ? err.message : String(err));
    }
    return false;
  }
}
