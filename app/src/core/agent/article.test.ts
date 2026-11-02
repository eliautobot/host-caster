// A long article comes back from news_article cut at the tool cap ("...(cut)"): the follow-up still reads its text.
import { expect, it } from 'vitest';
import { articleText } from './followup';

it('reads the text of a cut news_article answer', () => {
  const full = JSON.stringify({ title: 'T', text: 'Voters say "turnout" matters.\nMore here. ' + 'x'.repeat(4000) });
  expect(articleText(`${full.slice(0, 3500)}...(cut)`).startsWith('Voters say "turnout" matters.')).toBe(true);
  expect(articleText(JSON.stringify({ description: 'Short.' }))).toBe('Short.');
  expect(articleText('not json at all')).toBe('');
});
