import { describe, expect, it } from 'vitest'
import { ROLE_LABEL } from '../session/access'
import type { Role } from '../types'
import { DEMO_DB_ACCOUNTS } from './sampleAccounts'

describe('DEMO_DB_ACCOUNTS', () => {
  it('lists every app role, so the login page shows what the backend has and what it lacks', () => {
    const roles = new Set(DEMO_DB_ACCOUNTS.map(a => a.role))
    expect([...roles].sort()).toEqual((Object.keys(ROLE_LABEL) as Role[]).sort())
  })

  it('gives every row either a real account or a reason it has none', () => {
    for (const a of DEMO_DB_ACCOUNTS) {
      if (a.account) {
        expect(a.account.email).toMatch(/^[^@\s]+@[^@\s]+$/)
        expect(a.account.name).not.toBe('')
        expect(a.missing).toBeUndefined()
      } else {
        expect(a.missing).toMatch(/\.$/)
      }
    }
  })

  it('marks Admin and DevOps engineer as not in the backend yet', () => {
    const missing = DEMO_DB_ACCOUNTS.filter(a => !a.account).map(a => a.role)
    expect(missing.sort()).toEqual(['admin', 'devops'])
  })
})
