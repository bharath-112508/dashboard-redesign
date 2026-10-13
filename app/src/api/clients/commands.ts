import type { Db, ClientTeamMember, Question } from '../types'
import type { Resource } from '../commands'

/** The client team collection is part of the db. Declared here so api/types.ts only gains new types. */
declare module '../types' {
  interface Db {
    clientTeam: ClientTeamMember[]
  }
  interface Question {
    /** Who wrote the first client answer (stored as `answer`), so the chat can name them. */
    answerBy?: string
    /**
     * Set when the answer came from the chat: the index in `comments` of the client
     * message it mirrors. The thread then shows that message once (not the answer
     * as well), and editing the message edits the answer with it.
     */
    answerIdx?: number
  }
}

/** Writes the Clients portal makes that no other page sends. */
export type ClientsCommand =
  | { type: 'clientTeam.add'; member: ClientTeamMember }
  | { type: 'clientTeam.remove'; id: string }
  /** Edits one message in a question's chat. `index` is into `comments`, or -1 for the first answer; only its author (`who`) may change it. */
  | { type: 'question.editMessage'; id: number; index: number; who: string; text: string }

export const touchesClients = (cmd: { type: string }): Resource[] => {
  switch (cmd.type) {
    case 'clientTeam.add':
    case 'clientTeam.remove':
      return ['clientTeam']
    case 'question.editMessage':
      return ['questions']
    default:
      return []
  }
}

export const reduceClients = (db: Db, input: { type: string }): Db => {
  const c = input as ClientsCommand
  switch (c.type) {
    case 'clientTeam.add':
      return { ...db, clientTeam: [...(db.clientTeam ?? []), c.member] }
    case 'clientTeam.remove':
      return { ...db, clientTeam: (db.clientTeam ?? []).filter(m => m.id !== c.id) }
    case 'question.editMessage':
      return {
        ...db,
        questions: db.questions.map(q => {
          if (q.id !== c.id) return q
          if (c.index === -1) return q.answer && q.answerBy === c.who ? { ...q, answer: c.text } : q
          const comments = q.comments ?? []
          const m = comments[c.index]
          if (!m || m.who !== c.who) return q
          return {
            ...q,
            comments: comments.map((x, i) => (i === c.index ? { ...x, text: c.text } : x)),
            // The stored answer mirrors this message: keep it in step, so lists show the new text.
            ...(q.answerIdx === c.index ? { answer: c.text || 'Sent files' } : {}),
          }
        }),
      }
    default:
      return db
  }
}

/**
 * Stores saved before `answerIdx` hold a chat answer twice: as `answer` and as the
 * client's message in `comments`. Links the answer to that message so it shows once.
 */
export const linkChatAnswers = (questions: unknown): unknown =>
  Array.isArray(questions)
    ? questions.map(q => {
        if (!q || typeof q !== 'object') return q
        const x = q as Question
        if (!x.answer || x.answerIdx != null || !Array.isArray(x.comments)) return q
        const i = x.comments.findIndex(m => m.side === 'client')
        const m = x.comments[i]
        const same = !!m && (m.text || 'Sent files') === x.answer && (!x.answerBy || m.who === x.answerBy)
        return same ? { ...x, answerIdx: i } : q
      })
    : questions
