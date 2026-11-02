import { describe, expect, it } from 'vitest'
import { cleanTitle, parseOffline, titleWithoutWhen } from './understand'

// [what the model wrote as the title, what the listener said, the title we keep]
const TABLE: Array<[string, string, string, ('event' | 'task')?]> = [
  ['test Host-Caster tasks by Friday', 'Add a Google task to test Host-Caster tasks by Friday', 'Test Host-Caster tasks', 'task'],
  ['Test Host-Caster tasks by', 'Add a Google task to test Host-Caster tasks by Friday', 'Test Host-Caster tasks', 'task'],
  ['a Google task to test Host-Caster tasks by Friday', 'Add a Google task to test Host-Caster tasks by Friday', 'Test Host-Caster tasks', 'task'],
  ['Dentist Tuesday at 3', 'Put the dentist on my calendar Tuesday at 3', 'Dentist'],
  ['Dentist on Tuesday at 3 PM', 'Put the dentist on my calendar on Tuesday at 3 PM', 'Dentist'],
  ['Send the report due Monday', 'Add a task: send the report due Monday', 'Send the report', 'task'],
  ['Pay rent by the 1st', 'Add a Google task to pay rent by the 1st', 'Pay rent', 'task'],
  ['Call mom on Sunday', 'Add call mom on Sunday to my Google Tasks', 'Call mom', 'task'],
  ['Renew license before the end of the month', 'Add a task to renew my license before the end of the month', 'Renew license', 'task'],
  ['Lunch with Sam at noon', 'Book lunch with Sam at noon tomorrow', 'Lunch with Sam'],
  ['Team sync from 2 to 3 PM', 'Schedule team sync from 2 to 3 PM Thursday', 'Team sync'],
  ['Gym this coming week', 'Add gym this coming week to my tasks', 'Gym', 'task'],
  ['Book flights for next week', 'Add a task to book flights for next week', 'Book flights', 'task'],
  ['Water the plants in two days', 'Create a task to water the plants in two days', 'Water the plants', 'task'],
  ['File taxes until April 15', 'Add a task to file taxes until April 15', 'File taxes', 'task'],
  ['Pick up the cake tomorrow and the balloons', 'Add a task to pick up the cake tomorrow and the balloons', 'Pick up the cake and the balloons', 'task'],
  ['Haircut around 5 PM', 'Put a haircut on my calendar around 5 PM Saturday', 'Haircut'],
  ['Submit the form this Friday', 'Add a task to submit the form this Friday', 'Submit the form', 'task'],
  ['Dinner, Friday,', 'Put dinner on my calendar Friday at 7', 'Dinner'],
  ['Return the books to the library by 11/30', 'Add a task to return the books to the library by 11/30', 'Return the books to the library', 'task'],
  ['Call the bank first thing tomorrow morning', 'Add a task to call the bank tomorrow morning', 'Call the bank', 'task'],
  ['Mom 60th birthday dinner on Saturday', 'Put mom 60th birthday dinner on my calendar on Saturday at 6', 'Mom 60th birthday dinner'],
  ['Meet at the 5th floor lounge Wednesday', 'Put meet at the 5th floor lounge on my calendar Wednesday at 4', 'Meet at the 5th floor lounge'],
  ['Log in to the portal by Friday', 'Add a task to log in to the portal by Friday', 'Log in to the portal', 'task'],
  ['Check in', 'Add a task to check in tomorrow', 'Check in', 'task'],
  ['Turn the lights on', 'Add a task to turn the lights on tonight', 'Turn the lights on', 'task'],
  ['Prep slides for the 2026-11-06 review', 'Add a task to prep slides for the 2026-11-06 review', 'Prep slides for the review', 'task'],
  ['Order supplies by EOD', 'Add a task to order supplies by EOD', 'Order supplies', 'task'],
]

describe('titles: no day, time or dangling word is left behind', () => {
  it.each(TABLE)('%s', (model, said, want, kind) => {
    expect(cleanTitle(model, said, kind)).toBe(want)
  })

  it('never leaves a joiner at either end, doubled spaces or doubled punctuation', () => {
    for (const [model, said, , kind] of TABLE) {
      const t = cleanTitle(model, said, kind) ?? ''
      expect(t).not.toMatch(/\s{2}|[,.;:!?-]{2}|\s[,.;:!?]/)
      expect(t).not.toMatch(/\b(?:by|at|for|due|before|until|the|to|from|around|about|this|next)$/i)
      expect(t).not.toMatch(/^(?:by|at|for|due|before|until|the|to|from|around|about|this|next|on|in)\b/i)
    }
  })

  it('a title that is only a day and a time is no title', () => {
    expect(cleanTitle('Friday at 3', 'Put Friday at 3 on my calendar')).toBeUndefined()
    expect(titleWithoutWhen('by Friday')).toBe('')
  })

  it('the offline reader understands "add a Google task to ..."', () => {
    const r = parseOffline('Add a Google task to test Host-Caster tasks by Friday')
    expect(r.action).toBe('task.add')
    expect(cleanTitle(r.title, 'Add a Google task to test Host-Caster tasks by Friday', 'task')).toBe('Test Host-Caster tasks')
  })
})
