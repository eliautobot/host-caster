// Web search for the hosts on a self-hosted server: the operator's SearXNG, Brave Search or Tavily (config.agent.search).
// Operator-declared endpoints (a SearXNG on the same machine is fine), so plain providerFetch, not the user egress guard.
// The online edition searches through Host-Caster AI instead (online/included, metered per user).
import { capText, decodeEntities } from '../integrations/details.js';
import { HttpError } from '../errors.js';
import { providerFetch } from '../net/http.js';

const clean = (s, max) => capText(decodeEntities(String(s ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(), max);

/** @returns {{ text: string, sources: { title?: string, url: string }[] }} */
function fromResults(results, answer) {
  const top = results.filter((r) => r?.url && /^https?:/i.test(r.url)).slice(0, 5);
  const lines = top.map((r, i) => `${i + 1}. ${clean(r.title, 120)}${r.snippet ? `: ${clean(r.snippet, 300)}` : ''}`);
  return {
    text: [answer ? clean(answer, 600) : '', ...lines].filter(Boolean).join('\n') || 'No results.',
    sources: top.map((r) => ({ url: r.url, ...(r.title ? { title: clean(r.title, 160) } : {}) })),
  };
}

async function json(res, name) {
  if (!res.ok) throw new HttpError(502, 'search_failed', `${name} answered HTTP ${res.status}`);
  return res.json().catch(() => {
    throw new HttpError(502, 'search_failed', `${name} did not answer with JSON`);
  });
}

/**
 * @param {{ provider: string, searxngUrl?: string, braveKey?: string, tavilyKey?: string }} cfg
 * @param {string} query
 */
export async function searchWeb(cfg, query, { language = 'en' } = {}) {
  const q = String(query ?? '').trim().slice(0, 300);
  if (!q) throw new HttpError(400, 'invalid_request', 'Say what to search for');
  if (cfg.provider === 'searxng') {
    const url = `${cfg.searxngUrl}/search?${new URLSearchParams({ q, format: 'json', language, safesearch: '1' })}`;
    const j = await json(await providerFetch(url, { headers: { accept: 'application/json' } }, 15000), 'SearXNG');
    return fromResults((j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), j.answers?.[0]?.answer ?? j.answers?.[0]);
  }
  if (cfg.provider === 'brave') {
    const url = `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q, count: '5', safesearch: 'moderate' })}`;
    const j = await json(await providerFetch(url, { headers: { accept: 'application/json', 'x-subscription-token': cfg.braveKey } }, 15000), 'Brave Search');
    return fromResults((j.web?.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.description })));
  }
  if (cfg.provider === 'tavily') {
    const res = await providerFetch(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.tavilyKey}` },
        body: JSON.stringify({ query: q, max_results: 5, search_depth: 'basic', include_answer: true }),
      },
      20000,
    );
    const j = await json(res, 'Tavily');
    return fromResults((j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })), j.answer);
  }
  throw new HttpError(409, 'search_off', 'Web search is not set up on this server');
}
