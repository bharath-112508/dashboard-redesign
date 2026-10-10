import type { KeyboardEvent } from 'react'

/**
 * Keyboard activation for rows that act like buttons (expanders, task rows,
 * checklist items). Enter and Space run `fn`. Keys pressed on a nested control
 * (e.g. a button inside a sprint card) are left alone.
 */
export const onActivate = (fn: () => void) => (e: KeyboardEvent<HTMLElement>) => {
  if (e.target !== e.currentTarget) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    fn()
  }
}
