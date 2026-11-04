// Device speech in the phone app: an engine that never reports a line done (its service went away while the app
// slept) must not hold the break, and every break after it, forever.
import { afterEach, describe, expect, it, vi } from 'vitest';

const tts = vi.hoisted(() => ({ speak: vi.fn(), stop: vi.fn(async () => undefined) }));

vi.mock('../native', async (orig) => ({ ...(await orig<object>()), isNative: true, nativeTts: { ...tts, available: true, voices: async () => [] } }));

const { speakOnDevice } = await import('./device');

describe('speakOnDevice on the phone app', () => {
  afterEach(() => {
    vi.useRealTimers();
    tts.speak.mockReset();
    tts.stop.mockClear();
  });

  it('gives up on a line the engine never finishes, after its length and some room, and stops the engine', async () => {
    vi.useFakeTimers();
    tts.speak.mockReturnValue(new Promise(() => undefined));
    let done = false;
    const p = speakOnDevice({ text: 'One two three four five six seven eight nine ten.', voiceId: '', rate: 1, pitch: 1 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(done).toBe(true);
    expect(tts.stop).toHaveBeenCalledTimes(1);
  });

  it('a line the engine finishes ends right away, without a stop', async () => {
    tts.speak.mockResolvedValue(undefined);
    await speakOnDevice({ text: 'Hello there.', voiceId: '', rate: 1, pitch: 1 });
    expect(tts.stop).not.toHaveBeenCalled();
  });
});
