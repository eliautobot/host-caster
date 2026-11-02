import { describe, expect, it } from 'vitest'
import type { ActionTurn } from './callin'
import { actionTask } from './callin'
import { dropReason, linesAroundAction, repeatsLine } from './echo'

const ASK =
  'Just to check: Add "Host-Caster test" to your Google Calendar on Monday, November 2, from 4 PM to 5 PM. No one is invited. Should I go ahead? Just say yes or no.'
const turn = (kind: ActionTurn['kind'], line: string, extra: Partial<ActionTurn> = {}): ActionTurn => ({ kind, fact: '', line, ...extra })
const said = (lines: string[], t: ActionTurn) => linesAroundAction(lines.map((text, i) => ({ hostId: i % 2 ? 'b' : 'a', text })), t).map((l) => l.text)

describe('the code says its line once: model copies and rewordings are dropped (real round-4 transcripts)', () => {
  it('the read-back copied without quotes', () => {
    const copy = 'Just to check: Add Host-Caster test to your Google Calendar on Monday, November 2, from 4 PM to 5 PM. No one is invited. Should I go ahead? Just say yes or no.'
    expect(said(['Oh, a test run, love it, Sam!', copy], turn('asked', ASK))).toEqual(['Oh, a test run, love it, Sam!'])
  })
  it('the read-back copied inside a longer line keeps only the reaction', () => {
    expect(said([`Sure thing, Sam! ${ASK}`], turn('asked', ASK))).toEqual(['Sure thing, Sam!'])
  })
  it('a reworded question is dropped', () => {
    expect(said(['Happy to help.', 'Should I go ahead and put that on for you?', 'Want me to add it?'], turn('asked', ASK))).toEqual(['Happy to help.'])
  })
  it('"Okay, I will leave that alone." twice, and its rewordings', () => {
    const t = turn('cancelled', 'Okay, I will leave that alone.')
    expect(said(['Okay, I will leave that alone.'], t)).toEqual([])
    expect(said(['No problem at all, Sam.', "Got it, I won't add it.", 'Nothing was added.'], t)).toEqual(['No problem at all, Sam.'])
  })
  it('"Done. Test Host-Caster tasks is in your Google Tasks." twice', () => {
    const t = turn('done', 'Done. Test Host-Caster tasks is in your Google Tasks.')
    expect(said(['Done. Test Host-Caster tasks is in your Google Tasks.', 'Look at you, staying on top of things!'], t)).toEqual(['Look at you, staying on top of things!'])
    expect(said(['Done, it is in your Google Tasks now.', "I've popped it into Google Tasks."], t)).toEqual([])
  })
  it('the done line for the calendar, and a natural reaction stays', () => {
    const t = turn('done', 'Done. Dentist is on your Google Calendar for Tuesday, November 3, from 3 PM to 4 PM.')
    expect(said(['Hope the dentist goes well!', 'Dentist is on your calendar Tuesday from 3 to 4.', 'All done!'], t)).toEqual(['Hope the dentist goes well!'])
  })
  it('"Added to Your list: ... Just say yes or no." twice', () => {
    const line = 'Added to Your list: Renew your license, by the end of November (Monday, November 30). Want me to put it in Google Tasks too? It would say: Add "Renew your license" to Google Tasks, due Monday, November 30. Just say yes or no.'
    const t = turn('asked', line, { item: { id: 'i1' } as ActionTurn['item'] })
    expect(said([line], t)).toEqual([])
    expect(said(['Good call, Sam.', "I've added that to your list.", 'Added to your list: renew your license.'], t)).toEqual(['Good call, Sam.'])
  })
  it('a line that only repeats the code line word for word is dropped whole', () => {
    expect(said([ASK, ASK], turn('asked', ASK))).toEqual([])
  })
  it('repeatsLine: normalized compare, not fooled by quotes or case', () => {
    expect(repeatsLine('add host-caster test to your google calendar on monday', ASK)).toBe(true)
    expect(repeatsLine('Busy Monday for you then!', ASK)).toBe(false)
  })
})

describe('while a proposal waits, and after a no, nothing claims it happened', () => {
  it('the real one: "I\'ve got you covered there, Sam! That is one less thing ..." before the yes', () => {
    const lines = ["I've got you covered there, Sam! That is one less thing for you to worry about tonight.", 'Testing things out, I like it.']
    expect(said(lines, turn('asked', ASK))).toEqual(['Testing things out, I like it.'])
  })
  it.each([
    "You're all set!",
    "I'll pop that on your calendar.",
    "Consider it done.",
    "It's booked.",
    "That's taken care of.",
    "I'm adding it now.",
    "It'll be on your calendar in a second.",
    "We've locked it in.",
    "Let me put that in for you.",
  ])('asked: drops %s', (claim) => {
    expect(dropReason(claim, turn('asked', ASK))).toBe('claims')
  })
  it('curly apostrophes from real models are read the same', () => {
    const t = turn('asked', ASK)
    expect(dropReason('I’ve got you covered there, Sam!', t)).toBe('claims')
    expect(dropReason('You’re all set.', t)).toBe('claims')
    expect(dropReason('I’ll pop that on your calendar.', t)).toBe('claims')
    expect(dropReason('No worries, I won’t add it.', turn('cancelled', 'Okay, I will leave that alone.'))).toBe('repeat')
    // a thank-you for the request is not a claim
    expect(dropReason('Thanks for calling, Sam. I’ve got your request.', t)).toBeUndefined()
  })
  it('saying it can not be done right before the code asks to do it is dropped (seen live before an invitation read-back)', () => {
    const t = turn('asked', 'Just to check: Answer yes to "Q4 budget review" on Sunday, November 1, at 10:45 PM. Dana Reyes, the organizer, will see your answer. Should I go ahead? Just say yes or no.')
    expect(said(['Thanks for calling, Sam. I can’t accept it for you just yet.', 'You’ll get a quick confirmation check.'], t)).toEqual(['Thanks for calling, Sam.', 'You’ll get a quick confirmation check.'])
    expect(dropReason("I'm unable to add that for you.", turn('asked', ASK))).toBe('claims')
  })
  it('after a no, nothing implying it happened', () => {
    const t = turn('cancelled', 'Okay, I will leave that alone.')
    expect(said(["Fair enough. It's on your calendar anyway.", "You're all set.", 'Fair enough, Sam.'], t)).toEqual(['Fair enough.', 'Fair enough, Sam.'])
  })
  it('after a failure or a refusal too', () => {
    expect(said(["Done and dusted!", 'Oh no.'], turn('failed', 'Sorry, that did not work: Google Calendar did not answer, so nothing was added.'))).toEqual(['Oh no.'])
    expect(said(["I'll take care of it.", 'Ah, fair.'], turn('refused', 'Sorry, I can not help with payments and purchases. That one stays with you.'))).toEqual(['Ah, fair.'])
  })
  it('after it is done, a claim is true and stays (unless it repeats the line)', () => {
    const t = turn('done', 'Done. Dentist is on your Google Calendar for Tuesday, November 3, from 3 PM to 4 PM.')
    expect(said(["You're all set, Sam!"], t)).toEqual(["You're all set, Sam!"])
  })
  it('ordinary reactions stay', () => {
    const t = turn('asked', ASK)
    for (const ok of ['Oh nice, a test run!', 'Sam is busy this week.', 'Love the energy, Sam.', 'That sounds like a plan worth making.']) expect(dropReason(ok, t)).toBeUndefined()
  })
})

describe('the prompt tells the model the app says the line itself', () => {
  it('asked: nothing has happened yet', () => {
    const s = actionTask(turn('asked', ASK))
    expect(s).toContain('The app itself says this line')
    expect(s).toContain('do not copy it')
    expect(s).toContain('Nothing has happened yet')
  })
  it('cancelled: nothing was done', () => {
    expect(actionTask(turn('cancelled', 'Okay, I will leave that alone.'))).toContain('Nothing was done')
    expect(actionTask(turn('done', 'Done. X is in your Google Tasks.'))).not.toContain('Nothing')
  })
})
