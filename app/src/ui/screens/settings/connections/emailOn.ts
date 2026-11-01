// After a mailbox is connected (Gmail or IMAP): email goes on for every station, and the listener is told so.
import { radio } from '@/core/radio';
import { switchEmailOn } from '@/core/radio/emailOn';
import { toast } from '../../../components';

export async function emailOnForStations(): Promise<void> {
  const changed = await switchEmailOn().catch(() => []);
  if (!changed.length) return;
  const where = changed.length === 1 ? changed[0]!.name : `${changed.length} stations`;
  toast.success('Your hosts can mention new mail now', `Email is on for ${where}: who wrote and the subject, never the message. Turn it off in a station's settings.`);
  if (radio.state.onAir) await radio.reload().catch(() => undefined);
}
