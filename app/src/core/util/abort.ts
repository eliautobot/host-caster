// Waiting that always ends when its AbortSignal fires, even when the work underneath ignores the signal. Android's
// native HTTP (the app's fetch for POSTs) and the device speech engine do: a request on a connection that died while
// the phone slept never ended, so the break waiting for it never came and the hosts stayed silent until the app was
// closed. The caller moves on at its own limit; the stray work is dropped whenever it ends.

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** `p`, or a rejection with the signal's reason as soon as the signal aborts. */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/** `p`, or `fallback` once `ms` passed (a rejection of `p` passes through). */
export function settleWithin<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise<T | F>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
