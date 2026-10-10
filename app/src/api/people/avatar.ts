import { faceFor, initials } from '../../lib/media'
import type { Person } from '../types'

export interface Avatar {
  /** Two letters, always available. */
  initials: string
  /** A face or uploaded photo, or null for initials only. */
  photo: string | null
  colour: string
}

/**
 * How a person's avatar looks. An undefined photo means the built-in face; ''
 * means no photo. Client users see initials only, never photos or team colours.
 */
export const avatarOf = (p: Pick<Person, 'name' | 'colour' | 'photo'>, { showPhoto = true } = {}): Avatar => ({
  initials: initials(p.name),
  photo: !showPhoto ? null : p.photo === undefined ? faceFor(p.name) : p.photo || null,
  colour: p.colour,
})
