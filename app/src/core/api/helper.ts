// The desktop app's local helper (core/native/desktop.ts), called like the server: JSON in and out, errors as
// { error: { code, message } } turned into ApiError, so callers handle both the same way.
import { desktop, helperFetch } from '../native/desktop';
import { ApiError } from './client';

export async function helperRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const write = method !== 'GET' && method !== 'HEAD';
  const payload = body === undefined && write ? {} : body;
  let res: Response;
  try {
    res = await helperFetch(path, {
      method,
      headers: payload === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name;
    if (name === 'AbortError' && opts.signal?.aborted) throw err;
    if (name === 'TimeoutError' || timeout.aborted) throw new ApiError(0, 'timeout', 'Host-Caster on this computer took too long to answer');
    throw new ApiError(0, 'offline', 'The Host-Caster helper on this computer is not answering. Restart Host-Caster.');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText || `HTTP ${res.status}`;
    try {
      const e = (await res.json()) as { error: { code: string; message: string } };
      code = e.error.code;
      message = e.error.message;
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, code, message);
  }
  return (await res.json()) as T;
}

/**
 * Desktop app, signing out: the helper ends and forgets the ChatGPT sign-in made on this PC (it belongs to the person,
 * and the next account must not use it). Elsewhere, or with the helper gone, nothing to do.
 */
export async function forgetHelperSignIns(): Promise<void> {
  if (!desktop) return;
  await helperRequest('POST', '/api/account/signed-out', undefined, { timeoutMs: 10_000 }).catch(() => undefined);
}
