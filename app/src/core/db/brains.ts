import type { Brain, Draft, VoiceProvider } from '../types';
import { db } from './db';
import { stamp } from './stamp';

export function listBrains(): Promise<Brain[]> {
  return db.brains.toArray();
}

export function getBrain(id: string): Promise<Brain | undefined> {
  return db.brains.get(id);
}

export async function saveBrain(brain: Draft<Brain> | Brain): Promise<Brain> {
  const rec = stamp<Brain>(brain);
  await db.brains.put(rec);
  return rec;
}

export function deleteBrain(id: string): Promise<void> {
  return db.brains.delete(id);
}

export function listVoices(): Promise<VoiceProvider[]> {
  return db.voices.toArray();
}

export function getVoiceProvider(id: string): Promise<VoiceProvider | undefined> {
  return db.voices.get(id);
}

export async function saveVoiceProvider(voice: Draft<VoiceProvider> | VoiceProvider): Promise<VoiceProvider> {
  const rec = stamp<VoiceProvider>(voice);
  await db.voices.put(rec);
  return rec;
}

export function deleteVoiceProvider(id: string): Promise<void> {
  return db.voices.delete(id);
}
