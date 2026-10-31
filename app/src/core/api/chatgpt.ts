// "Use your ChatGPT plan": the server holds the user's ChatGPT sign-in (tokens never come to this device) and runs
// the requests. These calls connect, read the status, list models and disconnect.
import { request } from './client';

export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

export interface ChatGPTStatus {
  /** the server allows ChatGPT plan brains */
  enabled: boolean;
  /** signed in with plan use granted */
  connected: boolean;
  status: 'none' | 'pending' | 'connected' | 'not_enabled' | 'expired' | 'signed_out';
  account?: { email?: string; name?: string };
  planUsage: boolean;
  /** new requests wait until then after a usage-limit answer (ms) */
  limitedUntil?: number;
  lastError?: string;
  /** show "You're using your ChatGPT plan" once */
  welcome: boolean;
  attempt?: { status: 'pending' | 'done' | 'error' | 'idle'; code?: string; message?: string; at: number };
  manageUsageUrl: string;
}

export interface ChatGPTStart {
  authorizeUrl: string;
  /** http://127.0.0.1:<port>/auth/callback */
  redirectUri: string;
  /** the server listens on that address (works when the browser runs on the server's machine) */
  listening: boolean;
  /** signing in again with the saved registration */
  reusing: boolean;
}

export interface ChatGPTModel {
  slug: string;
  displayName: string;
}

export const chatgpt = {
  status: () => request<ChatGPTStatus>('GET', '/api/chatgpt/status'),
  /** fresh: a different ChatGPT account; reconsent: ask for plan use again; loopbackPort: this device listens */
  start: (opts: { fresh?: boolean; reconsent?: boolean; loopbackPort?: number } = {}) =>
    request<ChatGPTStart>('POST', '/api/chatgpt/start', opts),
  /** the address the ChatGPT tab ended on (http://127.0.0.1:.../auth/callback?code=...) */
  finish: (url: string) => request<ChatGPTStatus>('POST', '/api/chatgpt/finish', { url }),
  cancel: () => request<{ ok: boolean }>('POST', '/api/chatgpt/cancel', {}),
  welcomed: () => request<{ ok: boolean }>('POST', '/api/chatgpt/welcome', {}),
  models: () => request<{ models: ChatGPTModel[] }>('GET', '/api/chatgpt/models'),
  /** revoked = ChatGPT confirmed the sign-out */
  disconnect: () => request<{ revoked: boolean }>('POST', '/api/chatgpt/disconnect', {}),
};

/** Errors from a ChatGPT plan brain that the user can fix in ChatGPT settings. */
export const isChatGPTLimit = (code: string | undefined) => code === 'chatgpt_limit';
export const isChatGPTError = (code: string | undefined) => Boolean(code?.startsWith('chatgpt_'));
