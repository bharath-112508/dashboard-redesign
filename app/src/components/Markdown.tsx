import type { ReactNode } from 'react'
import { safeHref } from '../lib/files'

const INLINE = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\)|@[A-Za-z]+)/

function inline(text: string, k: number): ReactNode[] {
  const parts: ReactNode[] = []
  let rest = text
  let i = 0
  while (rest) {
    const m = rest.match(INLINE)
    if (!m || m.index === undefined) {
      parts.push(rest)
      break
    }
    if (m.index) parts.push(rest.slice(0, m.index))
    const s = m[0]
    const key = `${k}-${i}`
    if (s.startsWith('**')) parts.push(<b key={key}>{s.slice(2, -2)}</b>)
    else if (s.startsWith('_')) parts.push(<i key={key}>{s.slice(1, -1)}</i>)
    else if (s.startsWith('`'))
      parts.push(
        <code key={key} className="rounded-[5px] bg-sky-2 px-[5px] py-px font-mono text-[13px] text-blue-ink">
          {s.slice(1, -1)}
        </code>,
      )
    else if (s.startsWith('['))
      parts.push(
        <a key={key} href={safeHref(s.slice(s.indexOf('(') + 1, -1))} target="_blank" rel="noreferrer" className="hover:text-blue hover:underline">
          {s.slice(1, s.indexOf(']'))}
        </a>,
      )
    else
      parts.push(
        <span key={key} className="rounded-[5px] bg-sky-2 px-1 font-semibold text-blue-ink">
          {s}
        </span>,
      )
    rest = rest.slice(m.index + s.length)
    i++
  }
  return parts
}

/** Renders the small markdown subset the description editor writes. */
export function Markdown({ src }: { src: string }) {
  return (
    <div>
      {src.split('\n').map((ln, j) => {
        if (/^## /.test(ln))
          return (
            <div key={j} className="mb-0.5 mt-1.5 text-[16px] font-bold text-ink">
              {inline(ln.slice(3), j)}
            </div>
          )
        if (/^- \[( |x)\] /.test(ln)) {
          const on = ln[3] === 'x'
          return (
            <div key={j} className="flex items-baseline gap-2">
              <span
                className="grid size-3.5 flex-none translate-y-0.5 place-items-center rounded border-[1.5px] text-[10px] text-white"
                style={{ borderColor: on ? '#3F9079' : '#A9B6C5', background: on ? '#3F9079' : '#fff' }}
              >
                {on ? '✓' : ''}
              </span>
              <span style={{ textDecoration: on ? 'line-through' : 'none' }}>{inline(ln.slice(6), j)}</span>
            </div>
          )
        }
        if (/^- /.test(ln))
          return (
            <div key={j} className="flex gap-2">
              <span className="text-blue">•</span>
              <span>{inline(ln.slice(2), j)}</span>
            </div>
          )
        const num = ln.match(/^(\d+)\. /)
        if (num)
          return (
            <div key={j} className="flex gap-2">
              <span className="font-semibold text-blue">{num[1]}.</span>
              <span>{inline(ln.slice(num[0].length), j)}</span>
            </div>
          )
        if (/^> /.test(ln))
          return (
            <div key={j} className="border-l-[3px] border-line pl-2.5 text-muted">
              {inline(ln.slice(2), j)}
            </div>
          )
        if (/^!\[/.test(ln))
          return (
            <div key={j} className="my-0.5 inline-flex items-center gap-1.5 rounded-lg bg-sky-2 px-2.5 py-1 text-[13px] font-semibold text-blue-ink">
              {'🖼 ' + ln.slice(2, ln.indexOf(']'))}
            </div>
          )
        return (
          <div key={j} className="min-h-[1.65em]">
            {inline(ln, j)}
          </div>
        )
      })}
    </div>
  )
}
