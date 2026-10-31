// Brain presets. Default models change often: the Brains page lists the provider's live models, so a stale default
// only affects the first pick. Re-check before a release.
import type { BrainPreset } from '../types';

export interface BrainPresetInfo extends BrainPreset {
  /** an API key is needed (cloud providers) */
  keyRequired: boolean;
  /** one-line hint shown when picking the preset */
  note?: string;
  /** plan = a subscription the user signs in with (no API key); included = Host-Caster online plans */
  group: 'plan' | 'cloud' | 'local' | 'included';
}

const cloud = (p: Omit<BrainPresetInfo, 'local' | 'keyRequired' | 'group'>): BrainPresetInfo => ({
  ...p,
  local: false,
  keyRequired: true,
  group: 'cloud',
});

const local = (p: Omit<BrainPresetInfo, 'local' | 'keyRequired' | 'group' | 'kind'>): BrainPresetInfo => ({
  ...p,
  kind: 'openai',
  local: true,
  keyRequired: false,
  group: 'local',
});

export const BRAIN_PRESETS: BrainPresetInfo[] = [
  // online edition only (pickers show it when the server is the Host-Caster service)
  { id: 'hostcaster', name: 'Host-Caster AI', kind: 'hostcaster', baseUrl: '', defaultModel: 'hostcaster', local: false, keyRequired: false,
    group: 'included', note: 'Included with the Brain, Everything and Premium plans. Nothing to set up.' },
  { id: 'chatgpt', name: 'ChatGPT plan', kind: 'chatgpt', baseUrl: '', defaultModel: '', local: false, keyRequired: false,
    group: 'plan', note: 'Use your paid ChatGPT plan (Plus, Pro). No API key.' },
  cloud({ id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys' }),
  cloud({ id: 'anthropic', name: 'Anthropic Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-4-5', keyUrl: 'https://console.anthropic.com/settings/keys' }),
  cloud({ id: 'xai', name: 'xAI Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-3-mini',
    keyUrl: 'https://console.x.ai' }),
  cloud({ id: 'gemini', name: 'Google Gemini', kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey', note: 'Uses Gemini’s OpenAI-compatible endpoint.' }),
  cloud({ id: 'meta', name: 'Meta Llama API', kind: 'openai', baseUrl: 'https://api.llama.com/compat/v1',
    defaultModel: 'Llama-3.3-70B-Instruct', keyUrl: 'https://llama.developer.meta.com' }),
  cloud({ id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini', keyUrl: 'https://openrouter.ai/keys', note: 'One key, hundreds of models.' }),
  cloud({ id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', note: 'Very fast replies.' }),
  cloud({ id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest', keyUrl: 'https://console.mistral.ai/api-keys' }),
  cloud({ id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' }),
  cloud({ id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', keyUrl: 'https://api.together.ai/settings/api-keys' }),
  cloud({ id: 'fireworks', name: 'Fireworks', kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', keyUrl: 'https://fireworks.ai/account/api-keys' }),
  local({ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2',
    note: 'Runs on your computer or LAN. Use its address, e.g. http://192.168.1.20:11434/v1.' }),
  local({ id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', defaultModel: '',
    note: 'Start the local server in LM Studio and turn on CORS.' }),
  local({ id: 'llamacpp', name: 'llama.cpp server', baseUrl: 'http://localhost:8080/v1', defaultModel: '' }),
  local({ id: 'vllm', name: 'vLLM', baseUrl: 'http://localhost:8000/v1', defaultModel: '' }),
  local({ id: 'jan', name: 'Jan', baseUrl: 'http://localhost:1337/v1', defaultModel: '' }),
  { id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '', defaultModel: '', local: false,
    keyRequired: false, group: 'local', note: 'Any server that speaks the OpenAI chat completions API.' },
];

export function getPreset(id: string | undefined): BrainPresetInfo | undefined {
  return BRAIN_PRESETS.find((p) => p.id === id);
}
