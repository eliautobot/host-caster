import { describe, expect, it } from 'vitest';
import { looseFields } from './hostTools';

describe('describe your host', () => {
  it('reads host fields out of broken JSON from a small model', () => {
    const raw = '```json\n{\n"name": "Remy",\n"tagline": "Small stories, big laughs.",\n"energy": 3,\n"catchphrases": ["That\'s a beat!", "Drum it out!"],\n"emoji": 🎷"\n}\n```';
    expect(looseFields(raw)).toEqual({ name: 'Remy', tagline: 'Small stories, big laughs.', energy: 3, catchphrases: ["That's a beat!", 'Drum it out!'], emoji: '🎷' });
  });
});
