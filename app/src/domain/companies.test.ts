import { describe, expect, it } from 'vitest'
import { mainContactProblem } from './companies'

describe('mainContactProblem', () => {
  it('asks for an email when a main contact has a name but no email (they get an account by email)', () => {
    expect(mainContactProblem('Kari Berg', '  ')).toBe("Add the main contact's email so they can be invited.")
  })

  it('is fine with both filled, or neither', () => {
    expect(mainContactProblem('Kari Berg', 'kari@x.no')).toBeNull()
    expect(mainContactProblem('', '')).toBeNull()
  })
})
