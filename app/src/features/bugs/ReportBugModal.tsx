import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend } from '../../api/queries'
import type { ChatFile } from '../../api/types'
import { CloseButton, Icon, PATHS } from '../../components/ui'
import { todayLabel, TODAY } from '../../lib/dates'
import { readFiles } from '../../lib/files'
import { useOverlay, useUi } from '../../state/ui'
import { useActorName, useScopedTasks, useScopedWorkspace } from '../../state/access'
import { activeSprint, fileExt, nextTaskId } from '../../domain/tasks'

const PRIOS = ['Low', 'Medium', 'High', 'Critical'] as const

const schema = z.object({
  title: z.string().trim().min(1, 'Add a title'),
  desc: z.string(),
  prio: z.enum(PRIOS),
})
type Form = z.infer<typeof schema>

const PC: Record<(typeof PRIOS)[number], [string, string]> = {
  Low: ['#22354C', '#E7EEFB'],
  Medium: ['#1F3FAF', '#DCE5FA'],
  High: ['#7A5C0E', '#FBEDC2'],
  Critical: ['#FFFFFF', '#C0392B'],
}
const SUB = { Low: 'Small issue, no rush', Medium: 'Annoying but I can work', High: 'Blocks part of my work', Critical: 'Nothing works' }
const DOT = { Low: '#A9B6C5', Medium: '#4870E8', High: '#B98A2F', Critical: '#C0392B' }

/** The client's form for reporting a bug. The bug becomes a ticket for the team, with its own chat. */
export function ReportBugModal() {
  const overlay = useOverlay()
  const ui = useUi()
  const ws = useScopedWorkspace()!
  const tasks = useScopedTasks() ?? []
  const send = useSend()
  const me = useActorName()
  const [files, setFiles] = useState<ChatFile[]>([])
  const [drag, setDrag] = useState(false)
  const close = () => overlay.close('report')
  // `?report=top` comes from the Bugs column header "+": the bug goes to the top of the column.
  const top = overlay.get('report') === 'top'
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { title: '', desc: '', prio: 'Medium' } })
  const prio = watch('prio')
  const ok = !!watch('title').trim()

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const addFiles = async (list: File[]) => {
    const F = await readFiles(list)
    setFiles(f => [...f, ...F])
  }

  const onSubmit = (f: Form) => {
    const ds = todayLabel()
    send({
      type: 'task.create',
      top,
      task: {
        id: nextTaskId(tasks),
        title: f.title.trim(),
        type: 'Bug',
        status: ws.statuses[0].id,
        prio: f.prio,
        due: '',
        assignee: '',
        assignees: [],
        contribs: [],
        est: '',
        desc: f.desc.trim(),
        atts: files.map(x => ({ name: x.name, size: x.size, date: ds, url: x.url })),
        subs: [],
        deps: [],
        epic: ui.epic,
        sprint: activeSprint(ws.sprints, ui.epic)?.id ?? null,
        start: TODAY,
        time: {},
        acts: [{ kind: 'history', who: me, what: 'reported this bug', when: 'just now' }],
        clientBug: { reported: ds, chat: [] },
      },
    })
    close()
  }

  const titleField = register('title')

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[80] animate-fade-in bg-[rgba(27,45,69,0.45)]" />
      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="fixed left-1/2 top-1/2 z-[81] flex max-h-[calc(100vh-40px)] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 animate-pop-in flex-col overflow-hidden rounded-[22px] border-[1.5px] border-line bg-white shadow-[0_30px_90px_rgba(27,45,69,0.3)]"
      >
        <div className="flex items-center gap-3 border-b-[1.5px] border-line-3 px-6 py-5">
          <span className="grid size-10 flex-none place-items-center rounded-[11px] bg-red-soft text-red">
            <Icon d={PATHS.bug} size={20} sw={2.2} />
          </span>
          <div className="min-w-0">
            <div className="text-[19px] font-bold tracking-[-0.01em] text-ink">Report a bug</div>
            <div className="mt-0.5 text-[13px] text-ink-2">Tell us what went wrong. The team gets it as a ticket and replies in the chat.</div>
          </div>
          <CloseButton onClick={close} className="ml-auto" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 py-5">
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">
              What's the problem? <span className="text-red">*</span>
            </span>
            <input
              {...titleField}
              autoFocus
              placeholder="e.g. App crashes when I open a task"
              className="h-[46px] w-full rounded-xl border-[1.5px] bg-white px-3.5 py-[11px] text-[14.5px] font-semibold text-ink outline-0"
              style={{ borderColor: errors.title ? '#C0392B' : '#C9D2DD' }}
            />
            <span className="mt-[5px] block text-[12px] font-semibold text-red">{errors.title?.message}</span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">
              Description <span className="font-medium text-muted">· optional</span>
            </span>
            <textarea
              {...register('desc')}
              rows={5}
              placeholder={'What did you do, what happened, and what did you expect?\n\nDevice or browser:'}
              className="w-full resize-y rounded-xl border-[1.5px] border-line bg-white px-3.5 py-[11px] text-[14.5px] leading-[1.55] text-ink outline-0"
            />
          </label>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">How urgent is it?</span>
            <div className="grid grid-cols-4 gap-2">
              {PRIOS.map(p => {
                const on = p === prio
                const crit = on && p === 'Critical'
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setValue('prio', p)}
                    className="flex cursor-pointer flex-col items-start gap-[3px] rounded-xl border-[1.5px] px-3 py-2.5 text-left"
                    style={{ borderColor: on ? (p === 'Critical' ? '#C0392B' : PC[p][0]) : '#D6DEE8', background: on ? PC[p][1] : '#fff' }}
                  >
                    <span className="flex items-center gap-1.5 text-[13.5px] font-bold" style={{ color: on ? PC[p][0] : '#1B2D45' }}>
                      <span className="size-2 rounded-full" style={{ background: crit ? '#FFFFFF' : DOT[p] }} />
                      {p}
                    </span>
                    <span className="text-[11.5px] leading-[1.35]" style={{ color: crit ? '#FFFFFF' : '#3B4A5E' }}>
                      {SUB[p]}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink">
              Screenshots &amp; files <span className="font-medium text-muted">· optional</span>
            </span>
            <label
              onDragOver={e => {
                e.preventDefault()
                if (!drag) setDrag(true)
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={e => {
                e.preventDefault()
                setDrag(false)
                addFiles([...(e.dataTransfer?.files || [])])
              }}
              className="flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed p-5 text-center"
              style={{ borderColor: drag ? '#C0392B' : '#E8B4AA', background: drag ? '#FBEDEA' : '#FFFFFF' }}
            >
              <span className="grid size-9 place-items-center rounded-[10px] bg-red-soft text-red">
                <Icon d={PATHS.upload} size={18} sw={2.2} />
              </span>
              <span className="text-[13.5px] font-semibold text-ink">
                Drop files here or <span className="text-red">browse</span>
              </span>
              <span className="text-[12px] text-muted">Screenshots help us fix it faster</span>
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  addFiles([...(e.target.files || [])])
                  e.target.value = ''
                }}
              />
            </label>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {files.map((f, i) => (
                <div key={f.name + i} className="flex items-center gap-2.5 rounded-[10px] bg-canvas px-2.5 py-2 shadow-[inset_0_0_0_1.5px_#E4EAF0]">
                  <span className="grid size-8 flex-none place-items-center rounded-lg bg-sky-2 text-[9.5px] font-extrabold text-blue-ink">{fileExt(f.name)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{f.name}</span>
                  <span className="text-[12px] text-muted">{f.size}</span>
                  <button
                    type="button"
                    onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}
                    title="Remove"
                    className="size-7 cursor-pointer rounded-[7px] border-0 bg-transparent p-0 text-[16px] text-muted hover:bg-rust-soft hover:text-rust"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2.5 border-t-[1.5px] border-line-3 bg-canvas px-6 py-3.5">
          <button type="button" onClick={close} className="ml-auto h-10 cursor-pointer rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink">
            Cancel
          </button>
          <button
            type="submit"
            className="inline-flex h-10 cursor-pointer items-center gap-[7px] rounded-[10px] border-0 bg-red px-[18px] text-[13.5px] font-semibold text-white hover:bg-red-600"
            style={{ opacity: ok ? 1 : 0.45 }}
          >
            Report bug
          </button>
        </div>
      </form>
    </>
  )
}
