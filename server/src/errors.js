// JSON errors: { error: { code, message } }.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code machine-readable, snake_case
   * @param {string} [message]
   */
  constructor(status, code, message = code) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = status;
    this.code = code;
  }
}

export const errorBody = (code, message) => ({ error: { code, message } });

export function errorHandler(err, req, reply) {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  // our own HttpErrors at 5xx are upstream trouble (a provider said no): one warn line, no stack
  if (status >= 500 && err instanceof HttpError) req.log.warn({ code: err.code, status }, err.message);
  else if (status >= 500) req.log.error(err);
  const code = err instanceof HttpError ? err.code : err.validation ? 'invalid_request' : status >= 500 ? 'internal' : (err.code ?? 'error');
  const message = status >= 500 && !(err instanceof HttpError) ? 'Something went wrong' : err.message;
  reply.status(status).send(errorBody(String(code).toLowerCase(), message));
}
