import { useRef, useState, type KeyboardEvent } from 'react'
import { Icon, PATHS } from '../../components/ui'

type Tool = { tip: string; d: string; run: () => void; disabled?: boolean } | 'sep'

/** Description editor with a markdown toolbar, undo/redo and keyboard shortcuts. */
export function DescriptionEditor({
  initial,
  onSave,
  onCancel,
  onImage,
}: {
  initial: string
  onSave: (v: string) => void
  onCancel: () => void
  onImage: (f: File) => void
}) {
  const [draft, setDraft] = useState(initial)
  const [hist, setHist] = useState<string[]>([])
  const [fut, setFut] = useState<string[]>([])
  const ref = useRef<HTMLTextAreaElement>(null)

  /** Wraps the selection, or prefixes the current line. */
  const ins = (before: string, after: string, linePrefix?: string) => {
    const ta = ref.current
    const v = draft
    const a = ta ? ta.selectionStart : v.length
    const b = ta ? ta.selectionEnd : v.length
    let nv: string
    let pos: number
    if (linePrefix) {
      const ls = v.lastIndexOf('\n', a - 1) + 1
      nv = v.slice(0, ls) + linePrefix + v.slice(ls)
      pos = b + linePrefix.length
    } else {
      const sel = v.slice(a, b)
      nv = v.slice(0, a) + before + sel + after + v.slice(b)
      pos = a + before.length + sel.length
    }
    setHist(h => [...h, v].slice(-50))
    setFut([])
    setDraft(nv)
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus()
        ta.setSelectionRange(pos, pos)
      }
    })
  }

  const undo = () => {
    if (!hist.length) return
    setFut(f => [draft, ...f])
    setDraft(hist[hist.length - 1])
    setHist(h => h.slice(0, -1))
  }
  const redo = () => {
    if (!fut.length) return
    setHist(h => [...h, draft])
    setDraft(fut[0])
    setFut(f => f.slice(1))
  }
  const save = () => onSave(draft.trim())

  const tools: Tool[] = [
    { tip: 'Heading', d: 'M6 4v16M18 4v16M6 12h12', run: () => ins('', '', '## ') },
    { tip: 'Bold', d: 'M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z', run: () => ins('**', '**') },
    { tip: 'Italic', d: 'M14 4h-4M14 20h-4M14 4l-4 16', run: () => ins('_', '_') },
    'sep',
    { tip: 'Bullet list', d: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01', run: () => ins('', '', '- ') },
    { tip: 'Numbered list', d: 'M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 14h2.5L4 17.5h2.5', run: () => ins('', '', '1. ') },
    { tip: 'Checklist', d: 'M4 5h5v5H4zM4 14h5v5H4zM13 7.5h7M13 16.5h7', run: () => ins('', '', '- [ ] ') },
    'sep',
    { tip: 'Code', d: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14', run: () => ins('`', '`') },
    { tip: 'Quote', d: 'M5 6h4v6H5zM5 12c0 3 1.5 5 4 6M14 6h4v6h-4zM14 12c0 3 1.5 5 4 6', run: () => ins('', '', '> ') },
    { tip: 'Link', d: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1', run: () => ins('[', '](https://)') },
    { tip: 'Mention', d: 'M16 12a4 4 0 11-8 0 4 4 0 018 0zM16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-3.5 7.1', run: () => ins('@', '') },
    'sep',
    { tip: 'Undo', d: 'M9 14L4 9l5-5M4 9h11a5 5 0 010 10h-3', run: undo, disabled: !hist.length },
    { tip: 'Redo', d: 'M15 14l5-5-5-5M20 9H9a5 5 0 000 10h3', run: redo, disabled: !fut.length },
  ]

  const onKey = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === 'b') {
      e.preventDefault()
      ins('**', '**')
    } else if (e.key === 'i') {
      e.preventDefault()
      ins('_', '_')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  const toolBtn = 'grid size-[30px] flex-none cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent p-0 text-ink-2 hover:bg-sky-2 hover:text-blue-ink'
  const sep = <span className="mx-1 h-[18px] w-[1.5px] flex-none bg-line" />

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-[inset_0_0_0_1.5px_#4870E8,0_0_0_4px_rgba(72,112,232,0.14)]">
      <div className="flex items-center gap-0.5 overflow-x-auto border-b-[1.5px] border-line bg-canvas px-2 py-1.5">
        {sep}
        {tools.map((t, i) =>
          t === 'sep' ? (
            <span key={i} className="mx-1 h-[18px] w-[1.5px] flex-none bg-line" />
          ) : (
            <button key={t.tip} type="button" onClick={t.run} title={t.tip} className={toolBtn} style={{ opacity: t.disabled ? 0.35 : 1 }}>
              <Icon d={t.d} size={16} sw={2.1} />
            </button>
          ),
        )}
        <label title="Insert image" className={toolBtn}>
          <Icon d="M4 5h16v14H4zM4 15l4-4 5 5 3-3 4 4M15 9h.01" size={16} sw={2.1} />
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) {
                ins('\n![' + f.name + ']\n', '')
                onImage(f)
              }
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <textarea
        ref={ref}
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKey}
        rows={7}
        placeholder="Describe what should happen and why. Type @ to mention someone."
        className="block w-full resize-y border-0 bg-white px-4 py-3.5 text-[14.5px] leading-[1.65] text-ink outline-0"
      />
      <div className="flex items-center gap-2.5 border-t-[1.5px] border-line bg-canvas px-3 py-2.5">
        <span className="text-[12px] font-medium text-muted">⌘B bold · ⌘I italic · ⌘Enter save</span>
        <button
          type="button"
          onClick={onCancel}
          className="ml-auto h-9 cursor-pointer rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink hover:border-muted hover:bg-sky"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          className="inline-flex h-9 cursor-pointer items-center gap-[7px] rounded-[10px] border-0 bg-blue px-[18px] text-[13.5px] font-bold text-white shadow-[0_2px_6px_rgba(72,112,232,0.35)] hover:bg-blue-600"
        >
          <Icon d={PATHS.check} size={14} sw={2.8} />
          Save
        </button>
      </div>
    </div>
  )
}
