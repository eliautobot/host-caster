import type { ButtonHTMLAttributes, MouseEvent } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { MANAGE_USAGE_URL } from '@/core/api';
import { isNative, openExternal } from '@/core/native';
import { Button, Sheet } from '../../../components';
import { ChatGPTMark } from './ChatGPTMark';
import './chatgpt.css';

/** The approved "Continue with ChatGPT" button (black on light, white on dark), marked for OpenAI's checks. */
export function ContinueWithChatGPT({ loading, className, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      data-oai-siwc-button=""
      className={`aw-cgpt-btn${className ? ` ${className}` : ''}`}
      disabled={loading || disabled}
      aria-busy={loading || undefined}
    >
      {loading ? <Loader2 className="aw-cgpt-spin" size={21} aria-hidden /> : <ChatGPTMark />}
      <span>{loading ? 'Opening ChatGPT...' : 'Continue with ChatGPT'}</span>
    </button>
  );
}

/** Opens ChatGPT usage settings (system browser on the phone app). */
export function openManageUsage(e?: MouseEvent) {
  if (!isNative) return;
  e?.preventDefault();
  void openExternal(MANAGE_USAGE_URL);
}

export function ManageUsageLink({ className = 'aw-textlink' }: { className?: string }) {
  return (
    <a className={className} href={MANAGE_USAGE_URL} target="_blank" rel="noopener noreferrer" onClick={openManageUsage}>
      Manage usage <ExternalLink size={11} className="aw-cgpt-ext" aria-hidden />
    </a>
  );
}

/** "Using ChatGPT plan" next to the model picker. */
export function UsingPlan() {
  return (
    <p className="aw-cgpt-using">
      <ChatGPTMark size={16} />
      <span>Using ChatGPT plan</span>
      <span aria-hidden>·</span>
      <ManageUsageLink />
    </p>
  );
}

/** Compact usage-limit message: ChatGPT identity visible, Manage usage first. */
export function UsageLimit() {
  return (
    <div className="aw-cgpt-limit" role="status">
      <span className="aw-cgpt-tile">
        <ChatGPTMark size={20} />
      </span>
      <div className="aw-cgpt-limit__text">
        <p className="aw-cgpt-limit__brand">ChatGPT</p>
        <p className="aw-cgpt-limit__title">Usage limit reached</p>
        <p className="aw-cgpt-limit__desc">Review your plan or this app's limit in ChatGPT settings. Until then the scripted fallback fills in.</p>
      </div>
      <a className="aw-btn aw-btn--primary aw-btn--sm" href={MANAGE_USAGE_URL} target="_blank" rel="noopener noreferrer" onClick={openManageUsage}>
        Manage usage
      </a>
    </div>
  );
}

/** Shown once, the first time a user connects with ChatGPT plan use on. */
export function ChatGPTWelcome({ open, onDone }: { open: boolean; onDone: () => void }) {
  return (
    <Sheet
      open={open}
      onClose={onDone}
      size="sm"
      title={
        <span className="aw-cgpt-welcome__title">
          <span className="aw-cgpt-tile aw-cgpt-tile--lg">
            <ChatGPTMark size={28} />
          </span>
          You’re using your ChatGPT plan
        </span>
      }
      footer={
        <Button variant="primary" onClick={onDone}>
          Got it
        </Button>
      }
    >
      <p className="aw-cgpt-welcome__body">
        Eligible usage in this app uses your ChatGPT plan. <ManageUsageLink /> in your ChatGPT settings.
      </p>
    </Sheet>
  );
}
