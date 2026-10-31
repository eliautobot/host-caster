import { useState } from 'react';
import { AudioLines, BrainCircuit, Cpu, Plus, Sparkles } from 'lucide-react';
import { getPreset, testBrain, type BrainPresetInfo, type BrainTestResult } from '@/core/ai';
import type { Brain } from '@/core/types';
import { useBrains } from '@/state/brains';
import { useHosts } from '@/state/hosts';
import { hasAi } from '../../radio/fallback';
import { Button } from '../../components';
import { BrainSheet } from '../../radio/settings/BrainSheet';
import { ChatGPTMark } from '../../radio/settings/chatgpt/ChatGPTMark';
import { ChatGPTWelcome, ContinueWithChatGPT } from '../../radio/settings/chatgpt/ChatGPTParts';
import { useChatGPT } from '../../radio/settings/chatgpt/useChatGPT';
import '../../radio/forms.css';
import '../../online/online.css';

/** Brains: the AI models hosts think with. Hosts with none read scripted lines (the scripted fallback, never a choice). */
export default function Brains() {
  const brains = useBrains((s) => s.brains).filter((b) => b.kind !== 'connector');
  const hosts = useHosts((s) => s.hosts);
  const [sheet, setSheet] = useState<{ brain?: Brain; start?: BrainPresetInfo } | null>(null);
  const cg = useChatGPT();
  const hasPlanBrain = brains.some((b) => b.kind === 'chatgpt');
  const [tests, setTests] = useState<Record<string, BrainTestResult | 'busy'>>({});

  const usedBy = (id: string) => hosts.filter((h) => h.brainId === id).map((h) => h.name);
  const allBrains = useBrains((s) => s.brains);
  const noAi = useBrains((s) => s.ready) ? hosts.filter((h) => !hasAi(h, allBrains)).map((h) => h.name) : [];
  const run = async (b: Brain) => {
    setTests((t) => ({ ...t, [b.id]: 'busy' }));
    const r = await testBrain(b);
    setTests((t) => ({ ...t, [b.id]: r }));
    if (b.kind === 'chatgpt') void cg.refresh();
  };
  // "Continue with ChatGPT" from the banner: the sheet opens on the ChatGPT plan and the sign-in starts at once
  const startPlan = () => {
    setSheet({ start: getPreset('chatgpt') });
    if (cg.signedIn && !cg.status?.connected) void cg.begin(cg.status?.status === 'not_enabled' ? { reconsent: true } : {});
  };

  return (
    <div className="aw-fsec__body">
      {cg.serverOn && !hasPlanBrain && (
        <div className="aw-cgpt-banner">
          <span className="aw-cgpt-tile">
            <ChatGPTMark />
          </span>
          <div className="aw-cgpt-banner__text">
            <p className="aw-cgpt-banner__title">Use your ChatGPT plan</p>
            <p className="aw-cgpt-banner__desc">Have ChatGPT Plus or Pro? Your hosts can write their breaks on it. No API key.</p>
          </div>
          <ContinueWithChatGPT onClick={startPlan} />
        </div>
      )}
      <div className="aw-entries">
        {noAi.length > 0 && (
          <div className="aw-entry" data-fallback-note>
            <span className="aw-preset__icon">
              <AudioLines aria-hidden />
            </span>
            <div className="aw-entry__text">
              <p className="aw-entry__title">{brains.length ? `${noAi.join(', ')} ${noAi.length === 1 ? 'has' : 'have'} no AI yet` : 'No AI connected yet'}</p>
              <p className="aw-entry__meta">
                Until an AI is connected, the hosts read short scripted lines (song, time, weather, your day) so the music never goes quiet. Add one
                below to bring them to life.
              </p>
            </div>
          </div>
        )}
        {brains.map((b) => {
          const t = tests[b.id];
          const preset = getPreset(b.preset);
          const users = usedBy(b.id);
          return (
            <div key={b.id} className="aw-entry">
              {b.kind === 'chatgpt' ? (
                <span className="aw-preset__icon aw-cgpt-tile">
                  <ChatGPTMark size={20} />
                </span>
              ) : b.kind === 'hostcaster' ? (
                <span className="aw-preset__icon aw-included-tile">
                  <Sparkles aria-hidden />
                </span>
              ) : (
                <span className="aw-preset__icon">{preset?.local ? <Cpu aria-hidden /> : <BrainCircuit aria-hidden />}</span>
              )}
              <button type="button" className="aw-entry__text aw-entry__open" onClick={() => setSheet({ brain: b })}>
                <p className="aw-entry__title">{b.name}</p>
                <p className="aw-entry__meta aw-truncate">
                  {b.kind === 'hostcaster' ? 'Included with your plan' : b.model || 'No model'} ·{' '}
                  {b.kind === 'hostcaster'
                    ? 'Host-Caster AI'
                    : b.kind === 'chatgpt'
                    ? cg.status?.connected
                      ? cg.status.limitedUntil
                        ? 'Using ChatGPT plan · usage limit reached'
                        : 'Using ChatGPT plan'
                      : 'ChatGPT not connected'
                    : b.transport === 'server'
                      ? 'via your server'
                      : preset?.local
                        ? 'on your network'
                        : 'from this device'}
                  {users.length ? ` · ${users.join(', ')}` : ''}
                </p>
                {t && t !== 'busy' && <p className={`aw-statusline aw-statusline--${t.ok ? 'ok' : 'error'} aw-truncate`}>{t.message}</p>}
              </button>
              <Button size="sm" loading={t === 'busy'} onClick={() => run(b)}>
                Test
              </Button>
            </div>
          );
        })}
      </div>
      <div>
        <Button variant="primary" icon={Plus} onClick={() => setSheet({})}>
          Add a brain
        </Button>
      </div>
      <p className="aw-field__hint">
        Hosts that share a brain write each break together in one go. Hosts with different brains take turns, each
        thinking with their own. The scripted fallback: when an AI is out of reach, too slow or at a plan or usage
        limit, the hosts read a few scripted lines for that break and the music keeps playing.
      </p>
      <BrainSheet open={sheet !== null} brain={sheet?.brain} start={sheet?.start} cg={cg} onClose={() => setSheet(null)} />
      <ChatGPTWelcome open={Boolean(cg.status?.welcome && !cg.pending)} onDone={() => void cg.dismissWelcome()} />
    </div>
  );
}
