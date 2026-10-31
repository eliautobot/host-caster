// The phone's own 127.0.0.1 listener for Sign in with ChatGPT (Android plugin HostCasterLoopback). OpenAI sends the
// sign-in answer only to http://127.0.0.1:<port>/auth/callback; on the phone that address is the phone itself, so the
// app listens there and hands the answer to the Host-Caster server. Web and older app builds: not available (the server
// listens, or the user pastes the address).
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { hasPlugin } from './platform';

interface LoopbackPlugin {
  start(opts: { port?: number; done?: string }): Promise<{ port: number }>;
  stop(): Promise<void>;
  addListener(event: 'callback', cb: (e: { url: string }) => void): Promise<PluginListenerHandle>;
}

const Loopback = registerPlugin<LoopbackPlugin>('HostCasterLoopback');

export interface LoopbackListener {
  port: number;
  stop: () => void;
}

export const loopback = {
  available: (): boolean => hasPlugin('HostCasterLoopback'),
  /**
   * Listens on 127.0.0.1 (any free port) until the first callback. `onUrl` gets the full callback address; `done` is
   * the app's deep link the tab is sent to afterwards (brings the app back).
   */
  async listen(onUrl: (url: string) => void, done?: string): Promise<LoopbackListener> {
    let handle: PluginListenerHandle | undefined;
    const stop = () => {
      void handle?.remove();
      void Loopback.stop().catch(() => undefined);
    };
    handle = await Loopback.addListener('callback', (e) => {
      stop();
      onUrl(e.url);
    });
    try {
      const { port } = await Loopback.start({ port: 0, ...(done ? { done } : {}) });
      return { port, stop };
    } catch (err) {
      stop();
      throw err;
    }
  },
};
