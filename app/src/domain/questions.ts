import type { ChatMessage, Question } from '../api/types'

/** The conversation as shown in the chat: the client's first answer, then every message. */
export const threadOf = (q: Question): ChatMessage[] => [
  ...(q.answer ? [{ who: q.answerBy || 'Client', side: 'client' as const, text: q.answer, when: q.answeredWhen || '', files: [] }] : []),
  ...(q.comments || []),
]

/**
 * Where a question stands from the client's side: they still have to answer,
 * the team has replied since their last message, or they are waiting for the team.
 */
export const clientQuestionState = (q: Question) => {
  const T = threadOf(q)
  let li = -1
  T.forEach((x, k) => {
    if (x.side === 'client') li = k
  })
  const nNew = li < 0 ? 0 : T.slice(li + 1).filter(x => x.side === 'team').length
  const need = li < 0
  const replies = nNew + ' new repl' + (nNew === 1 ? 'y' : 'ies')
  if (q.solved)
    return { label: 'Solved', ord: 3, cardBg: '#3F9079', cardC: '#FFFFFF', boxC: '#195040', cta: 'View solved question ›', need, nNew }
  if (need)
    return { label: 'Needs your answer', ord: 0, cardBg: '#FBEDC2', cardC: '#7A5C0E', boxC: '#7A5C0E', cta: 'Open to answer ›', need, nNew }
  if (nNew)
    return { label: replies, ord: 1, cardBg: '#6E58C9', cardC: '#FFFFFF', boxC: '#3F2E94', cta: 'Read and reply ›', need, nNew }
  return { label: 'Waiting for team', ord: 2, cardBg: '#E7EEFB', cardC: '#1F3FAF', boxC: '#1F3FAF', cta: 'Open conversation ›', need, nNew }
}
