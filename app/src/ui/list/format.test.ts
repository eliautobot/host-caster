import { describe, expect, it } from 'vitest';
import type { TrackedItem } from '@/core/types';
import { applyFilter, canUndo, countdown, dueLabel, plain, snoozeChoices, statusLine, untilWords, whoLine } from './format';

// Wednesday, Nov 4 2026, 10:30 local
const NOW = new Date(2026, 10, 4, 10, 30).getTime();
const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}`;

const item = (over: Partial<TrackedItem>): TrackedItem => ({
  id: Math.random().toString(36).slice(2),
  createdAt: NOW,
  updatedAt: NOW,
  what: 'x',
  kind: 'todo',
  source: { type: 'you', label: 'You' },
  status: 'open',
  key: 'k',
  ...over,
});

describe('dueLabel', () => {
  it('says today, tomorrow and a short date', () => {
    expect(dueLabel({ due: day(4), status: 'open' }, NOW)).toEqual({ text: 'Today', overdue: false });
    expect(dueLabel({ due: day(5), status: 'open' }, NOW)).toEqual({ text: 'Tomorrow', overdue: false });
    expect(dueLabel({ due: day(6), status: 'open' }, NOW)?.text).toBe('Fri, Nov 6');
  });
  it('adds the time for timed dues and reminders', () => {
    expect(dueLabel({ due: new Date(2026, 10, 5, 15).toISOString(), status: 'open' }, NOW)?.text).toBe('Tomorrow, 3 PM');
    expect(dueLabel({ remindAt: new Date(2026, 10, 4, 17, 30).getTime(), status: 'open' }, NOW)?.text).toBe('Reminder today, 5:30 PM');
  });
  it('marks overdue, but never for done items', () => {
    expect(dueLabel({ due: day(3), status: 'open' }, NOW)).toEqual({ text: 'Overdue: yesterday', overdue: true });
    expect(dueLabel({ due: day(1), status: 'open' }, NOW)).toEqual({ text: 'Overdue: Sun, Nov 1', overdue: true });
    expect(dueLabel({ due: new Date(2026, 10, 4, 9).toISOString(), status: 'open' }, NOW)).toEqual({ text: 'Overdue: today, 9 AM', overdue: true });
    expect(dueLabel({ due: day(1), status: 'done' }, NOW)?.overdue).toBe(false);
  });
  it('names the year when it is not this year, and nothing without a due', () => {
    expect(dueLabel({ due: '2027-01-08', status: 'open' }, NOW)?.text).toBe('Fri, Jan 8, 2027');
    expect(dueLabel({ status: 'open' }, NOW)).toBeUndefined();
    expect(dueLabel({ due: 'soon', status: 'open' }, NOW)).toBeUndefined();
  });
});

describe('snooze and countdown', () => {
  it('offers later today only while it is still today', () => {
    expect(snoozeChoices(NOW).map((c) => c.label)).toEqual(['Later today', 'Tomorrow', 'Next week']);
    const late = new Date(2026, 10, 4, 22).getTime();
    expect(snoozeChoices(late).map((c) => c.label)).toEqual(['Tomorrow', 'Next week']);
  });
  it('tomorrow at 9 and next Monday at 9', () => {
    const [, tomorrow, week] = snoozeChoices(NOW);
    expect(new Date(tomorrow!.until).getHours()).toBe(9);
    expect(new Date(tomorrow!.until).getDate()).toBe(5);
    expect(new Date(week!.until).getDay()).toBe(1);
    expect(new Date(week!.until).getDate()).toBe(9);
    expect(untilWords(tomorrow!.until, NOW)).toBe('tomorrow, 9 AM');
  });
  it('counts down in m:ss', () => {
    expect(countdown(299_400)).toBe('5:00');
    expect(countdown(65_000)).toBe('1:05');
    expect(countdown(-3)).toBe('0:00');
  });
});

describe('filters and words', () => {
  const rows = [
    item({ kind: 'todo' }),
    item({ kind: 'prepare' }),
    item({ kind: 'waiting', who: 'Dana' }),
    item({ kind: 'bill', status: 'snoozed', snoozedUntil: NOW + 1000 }),
    item({ kind: 'invite' }),
    item({ kind: 'todo', status: 'done', doneAt: NOW }),
    item({ kind: 'todo', status: 'dismissed' }),
  ];
  it('splits by kind and keeps done and dismissed apart', () => {
    expect(applyFilter(rows, 'all')).toHaveLength(5);
    expect(applyFilter(rows, 'todo')).toHaveLength(2);
    expect(applyFilter(rows, 'bill')).toHaveLength(1);
    expect(applyFilter(rows, 'done')).toHaveLength(1);
  });
  it('says who in plain words', () => {
    expect(whoLine({ who: 'Dana', kind: 'waiting' })).toBe('Waiting on Dana');
    expect(whoLine({ who: 'Dana Reyes', kind: 'invite' })).toBe('From Dana Reyes');
    expect(whoLine({ who: 'Northwind Billing', kind: 'bill' })).toBe('From Northwind Billing');
    expect(whoLine({ who: 'Dana', kind: 'todo' })).toBe('With Dana');
    expect(whoLine({ kind: 'todo' })).toBeUndefined();
  });
  it('status lines are honest and have no em dash', () => {
    expect(statusLine({ status: 'failed', error: { code: 'x', message: 'Google Calendar did not answer \u2014 so nothing was added.' } }).text).toBe(
      'Not done: Google Calendar did not answer, so nothing was added',
    );
    expect(statusLine({ status: 'undone' }).text).toBe('Undone');
    expect(plain('a \u2014 b')).toBe('a, b');
  });
  it('offers undo for a week', () => {
    const a = { status: 'done' as const, undoable: true, createdAt: NOW, executedAt: NOW };
    expect(canUndo(a, NOW + 1000)).toBe(true);
    expect(canUndo(a, NOW + 8 * 86_400_000)).toBe(false);
    expect(canUndo({ ...a, undoable: false }, NOW)).toBe(false);
  });
});
