// /api/chatgpt/*: connect, status, models and disconnect for "Use your ChatGPT plan" brains. Inference runs through
// POST /api/ai/chat (brain kind 'chatgpt'). Tokens never appear in any answer.
import { requireUser } from '../auth/session.js';
import { chatgptError, MANAGE_USAGE_URL } from './errors.js';

function pastedUrl(value) {
  const text = String(value ?? '').trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    throw chatgptError.flow('Paste the whole address from the ChatGPT tab (it starts with http://127.0.0.1).');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw chatgptError.flow('That is not the ChatGPT sign-in address. It starts with http://127.0.0.1.');
  }
  return url;
}

export async function chatgptRoutes(app) {
  const svc = app.chatgpt;

  app.get('/api/chatgpt/status', async (req) => ({ ...svc.status(requireUser(req).id), manageUsageUrl: MANAGE_USAGE_URL }));

  app.post('/api/chatgpt/start', async (req) => {
    const user = requireUser(req);
    const b = req.body ?? {};
    return svc.start(user.id, { fresh: b.fresh === true, reconsent: b.reconsent === true, loopbackPort: b.loopbackPort });
  });

  app.post('/api/chatgpt/finish', async (req) => {
    const user = requireUser(req);
    await svc.complete(pastedUrl(req.body?.url), user.id);
    return { ...svc.status(user.id), manageUsageUrl: MANAGE_USAGE_URL };
  });

  app.post('/api/chatgpt/cancel', async (req) => {
    svc.clearAttempt(requireUser(req).id);
    return { ok: true };
  });

  app.post('/api/chatgpt/welcome', async (req) => {
    svc.welcomed(requireUser(req).id);
    return { ok: true };
  });

  app.get('/api/chatgpt/models', async (req) => ({ models: await svc.models(requireUser(req).id) }));

  app.post('/api/chatgpt/disconnect', async (req) => svc.disconnect(requireUser(req).id));
}
