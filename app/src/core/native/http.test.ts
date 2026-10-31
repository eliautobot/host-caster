import { describe, expect, it } from 'vitest';
import { base64ToBytes, nativeFetch, responseFromNative } from './http';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('core/native http', () => {
  it('decodes base64 (with line breaks) to bytes', () => {
    expect(Array.from(base64ToBytes(`${b64([0xff, 0xfb, 0x90, 0x00])}\n`))).toEqual([0xff, 0xfb, 0x90, 0x00]);
  });

  it('turns a native arraybuffer answer into a binary Response', async () => {
    const mp3 = [0x49, 0x44, 0x33, 0x04, 0x00, 0xff, 0x00, 0x80];
    const res = responseFromNative({
      status: 200,
      url: 'http://tts.local/v1/audio/speech',
      headers: { 'Content-Type': 'audio/mpeg' },
      data: b64(mp3),
    });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://tts.local/v1/audio/speech');
    const blob = await res.blob();
    expect(blob.type).toBe('audio/mpeg');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual(mp3);
  });

  it('keeps error and JSON bodies as text', async () => {
    const err = responseFromNative({ status: 400, url: '', headers: { 'content-type': 'application/json' }, data: '{"error":"bad voice"}' });
    expect(err.status).toBe(400);
    expect(await err.json()).toEqual({ error: 'bad voice' });
    const parsed = responseFromNative({ status: 200, url: '', headers: {}, data: { models: ['kokoro'] } });
    expect(await parsed.json()).toEqual({ models: ['kokoro'] });
  });

  it('maps odd statuses and empty bodies safely', async () => {
    expect(responseFromNative({ status: 0, url: '', headers: {}, data: '' }).status).toBe(502);
    const none = responseFromNative({ status: 204, url: '', headers: {}, data: 'x' });
    expect(none.status).toBe(204);
    expect(await none.text()).toBe('');
  });

  it('is plain fetch on web', async () => {
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response('ok');
    }) as typeof fetch;
    try {
      const res = await nativeFetch('http://tts.local/v1/audio/speech', { method: 'POST', body: '{}' });
      expect(await res.text()).toBe('ok');
      expect(calls).toEqual(['http://tts.local/v1/audio/speech']);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
