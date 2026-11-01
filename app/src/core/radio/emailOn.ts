// Connecting a mailbox (Gmail or IMAP, whichever the server offers) switches the email topic on for every station, so
// the hosts can mention new mail right away. Returns the stations that changed (the UI tells the listener).
import { listStations, saveStation } from '../db';
import type { Station } from '../types';

export async function switchEmailOn(): Promise<Station[]> {
  const off = (await listStations()).filter((s) => !s.segments.email);
  return Promise.all(off.map((s) => saveStation({ ...s, segments: { ...s.segments, email: true } })));
}
