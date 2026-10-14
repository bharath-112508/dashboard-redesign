import { describe, expect, it } from 'vitest'
import { demoAccountsOn } from './config'

describe('demoAccountsOn', () => {
  it('lists the Demo DB accounts on the login page only in an API build that asks for them', () => {
    expect(demoAccountsOn(true, 'true')).toBe(true)
    expect(demoAccountsOn(true, undefined)).toBe(false)
    expect(demoAccountsOn(true, 'false')).toBe(false)
    expect(demoAccountsOn(false, 'true')).toBe(false)
  })
})
