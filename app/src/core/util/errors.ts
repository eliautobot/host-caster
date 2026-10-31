// Errors shared across core modules.

/** Thrown by stubs that a module owner has not filled in yet. */
export class NotImplementedError extends Error {
  override name = 'NotImplementedError';
  constructor(readonly feature: string) {
    super(`${feature} is not built yet`);
  }
}

export function notImplemented(feature: string): never {
  throw new NotImplementedError(feature);
}

export function isNotImplemented(err: unknown): err is NotImplementedError {
  return err instanceof NotImplementedError;
}
