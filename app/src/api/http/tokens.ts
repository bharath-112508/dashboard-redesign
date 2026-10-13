/** The backend's access and refresh tokens, kept in this browser (`vt.tokens`). */
export type Tokens = { access: string; refresh: string }

const KEY = 'vt.tokens'

const isTokens = (v: unknown): v is Tokens =>
  !!v && typeof v === 'object' && typeof (v as Tokens).access === 'string' && typeof (v as Tokens).refresh === 'string'

export const readTokens = (): Tokens | null => {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    return isTokens(v) ? v : null
  } catch {
    return null
  }
}

export const writeTokens = (t: Tokens) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(t))
  } catch {
    // Storage is blocked: the user has to sign in again after a reload.
  }
}

export const clearTokens = () => {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing to clear.
  }
}
