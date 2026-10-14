import { findPersonByEmail } from '../people/directory'
import type { Company, Person, Session } from '../types'

/** The shared demo password. Passwords set from a profile replace it for that person. */
export const DEMO_PASSWORD = 'demo'

export type SignInResult =
  | { ok: true; session: Session }
  | { ok: false; field: 'email' | 'password'; message: string }
  /** API mode: the account uses two-step sign-in; `mfa` is the session token for the code step. */
  | { ok: false; mfa: string }

/** SHA-256 of a string, as lowercase hex. Needs a secure context (https or localhost). */
export const sha256 = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const passwordOk = async (person: Person, password: string): Promise<boolean> => {
  if (!person.pwHash) return password === DEMO_PASSWORD
  try {
    return (await sha256(password)) === person.pwHash
  } catch {
    // No crypto.subtle here: the stored password cannot be checked, so it is refused.
    return false
  }
}

/** The session a person gets when they sign in. */
export const sessionFor = (person: Person, companies: readonly Company[]): Session => {
  const company = person.org === 'vt' ? null : companies.find(c => c.id === person.org)
  return {
    personId: person.id,
    name: person.name,
    email: person.email,
    role: person.role,
    org: person.org === 'vt' ? 'Viljetech' : company?.name ?? person.org,
    ...(person.org === 'vt' ? {} : { orgId: person.org }),
    ...(person.emp ? { emp: person.emp } : {}),
    ...(person.phone ? { phone: person.phone } : {}),
    ...(person.tz ? { tz: person.tz } : {}),
    ...(person.notif ? { notif: person.notif } : {}),
  }
}

/**
 * Checks an email and password against the directory. The email is matched
 * ignoring case; the password is checked against the person's own password if
 * they have set one, or the demo password otherwise. Deactivated people are refused.
 */
export const signIn = async (
  email: string,
  password: string,
  people: readonly Person[],
  companies: readonly Company[],
): Promise<SignInResult> => {
  if (!email.trim()) return { ok: false, field: 'email', message: 'Enter your email.' }
  const person = findPersonByEmail(people, email)
  if (!person) {
    return { ok: false, field: 'email', message: 'No user with that email. Pick a sample user on the right.' }
  }
  if (!password) return { ok: false, field: 'password', message: 'Enter your password.' }
  if (!(await passwordOk(person, password))) {
    return { ok: false, field: 'password', message: 'That password is not right.' }
  }
  if (!person.active) {
    return { ok: false, field: 'email', message: 'This account is deactivated. Ask an admin to reactivate it.' }
  }
  return { ok: true, session: sessionFor(person, companies) }
}
