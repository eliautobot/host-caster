// State for "Use your ChatGPT plan": the server's status, a sign-in in progress (polled until the 127.0.0.1 callback
// or a pasted address finishes it), models, disconnect. Tokens never reach this device.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, chatgpt, type ChatGPTModel, type ChatGPTStart, type ChatGPTStatus } from '@/core/api';
import { APP_SCHEME, isDesktop, isNative, loopback, openAuthUrl, type LoopbackListener } from '@/core/native';
import { useDesktop } from '@/state/desktop';
import { useSession } from '@/state/session';
import { toast } from '../../../components';

const POLL_MS = 2000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface ChatGPTSignIn {
  start: ChatGPTStart;
  /** the browser blocked the new tab: show a link instead */
  blocked: boolean;
  /** this phone listens on its own 127.0.0.1 for the answer (Android app) */
  local: boolean;
}

export function useChatGPT() {
  // the desktop app keeps the ChatGPT sign-in on this computer (its local helper): no Host-Caster sign-in needed for it,
  // and it is on only when Settings, Desktop app says so
  const signedIn = useSession((s) => Boolean(s.session)) || isDesktop;
  const serverPlan = useSession((s) => s.config?.chatgptPlan !== false);
  const desktopPlan = useDesktop((s) => s.settings?.chatgptPlan === true);
  const serverOn = isDesktop ? desktopPlan : serverPlan;
  const [status, setStatus] = useState<ChatGPTStatus>();
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<ChatGPTSignIn>();
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<ChatGPTModel[]>();
  const alive = useRef(true);
  const listener = useRef<LoopbackListener>(undefined);
  const stopListening = () => {
    listener.current?.stop();
    listener.current = undefined;
  };

  const refresh = useCallback(async () => {
    if (!signedIn) return undefined;
    try {
      const s = await chatgpt.status();
      if (alive.current) setStatus(s);
      return s;
    } catch (err) {
      if (alive.current) setError(message(err));
      return undefined;
    }
  }, [signedIn]);

  useEffect(() => {
    alive.current = true;
    if (signedIn) {
      setLoading(true);
      void refresh().finally(() => alive.current && setLoading(false));
    }
    return () => {
      alive.current = false;
      stopListening();
    };
  }, [signedIn, refresh]);

  // a sign-in in progress: the server finishes it (callback on its own 127.0.0.1, or a pasted address)
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(async () => {
      const s = await refresh();
      if (!s?.attempt || s.attempt.status === 'pending') return;
      setPending(undefined);
      stopListening();
      if (s.attempt.status === 'error') setError(s.attempt.message ?? 'ChatGPT sign-in did not finish.');
    }, POLL_MS);
    return () => clearInterval(t);
  }, [pending, refresh]);

  /** Continue with ChatGPT. Opens the tab first (popup blockers allow it only inside the click). */
  const begin = useCallback(async (opts: { fresh?: boolean; reconsent?: boolean } = {}) => {
    setError(undefined);
    const tab = isNative || isDesktop ? null : window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      // Android app: the answer comes back to this phone's 127.0.0.1, where the app listens and passes it on
      stopListening();
      if (isNative && loopback.available()) {
        listener.current = await loopback.listen((url) => void finishWith(url), `${api.config?.appScheme ?? APP_SCHEME}://chatgpt`);
      }
      const start = await chatgpt.start({ ...opts, ...(listener.current ? { loopbackPort: listener.current.port } : {}) });
      // phones and the desktop app: the system browser (the desktop helper's own 127.0.0.1 catches the answer)
      if (isNative || isDesktop) await openAuthUrl(start.authorizeUrl);
      else if (tab) tab.location.href = start.authorizeUrl;
      setPending({ start, blocked: !isNative && !isDesktop && !tab, local: Boolean(listener.current) || (isDesktop && start.listening) });
    } catch (err) {
      tab?.close();
      stopListening();
      setError(message(err));
    }
    // finishWith is stable (declared below with no deps)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** the answer from this phone's listener */
  const finishWith = async (url: string) => {
    try {
      const s = await chatgpt.finish(url);
      if (!alive.current) return;
      setStatus(s);
      setPending(undefined);
    } catch (err) {
      if (alive.current) setError(message(err));
    }
  };

  const paste = useCallback(async (url: string) => {
    setError(undefined);
    try {
      const s = await chatgpt.finish(url);
      setStatus(s);
      setPending(undefined);
      return true;
    } catch (err) {
      setError(message(err));
      return false;
    }
  }, []);

  const cancel = useCallback(() => {
    setPending(undefined);
    stopListening();
    void chatgpt.cancel().catch(() => undefined);
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const { models: list } = await chatgpt.models();
      setModels(list);
      return list;
    } catch (err) {
      setError(message(err));
      void refresh();
      return [];
    }
  }, [refresh]);

  const disconnect = useCallback(async () => {
    try {
      const { revoked } = await chatgpt.disconnect();
      // status first: with models cleared while still "connected", the form would ask for models again
      await refresh();
      setModels(undefined);
      setError(undefined);
      toast(
        revoked
          ? { tone: 'success', title: 'ChatGPT disconnected' }
          : { title: 'Disconnected here', description: 'ChatGPT did not confirm the sign-out. You can remove Host-Caster in ChatGPT Settings.', duration: 9000 },
      );
    } catch (err) {
      toast.error('Could not disconnect', message(err));
      await refresh();
    }
  }, [refresh]);

  const dismissWelcome = useCallback(async () => {
    setStatus((s) => (s ? { ...s, welcome: false } : s));
    await chatgpt.welcomed().catch(() => undefined);
  }, []);

  return { signedIn, serverOn, status, loading, pending, error, setError, models, begin, paste, cancel, loadModels, disconnect, refresh, dismissWelcome };
}

export type ChatGPTState = ReturnType<typeof useChatGPT>;
