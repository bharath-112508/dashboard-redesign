import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend, useWorkspace } from '../../api/queries'
import { useOverlay } from '../../state/ui'
import { useEscape } from '../useEscape'

const schema = z.object({
  name: z.string().trim().min(1, 'Add a name'),
  story: z.string().trim().min(1, 'Describe the requirement'),
})
type Form = z.infer<typeof schema>

export const fieldCls = 'w-full rounded-[10px] border-[1.5px] border-line bg-white px-3 py-[9px] text-[14px] text-ink outline-0'
export const labelCls = 'mb-1.5 block text-[12px] font-bold text-ink-2'

/** "New epic": what is being built. */
export function EpicFormModal() {
  const ws = useWorkspace().data!
  const send = useSend()
  const overlay = useOverlay()
  const close = () => overlay.close('newEpic')
  useEscape(close)
  const { register, handleSubmit, watch } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { name: '', story: '' } })
  const ok = !!watch('name').trim() && !!watch('story').trim()

  const onSubmit = (f: Form) => {
    const story = f.story.trim()
    send({
      type: 'epic.create',
      epic: { id: 'e' + Date.now(), name: f.name.trim(), p: ws.epics.length, desc: story.split('\n')[0].slice(0, 90), goal: '', story, criteria: [] },
    })
    close()
  }

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[70] bg-[rgba(27,45,69,0.38)]" />
      <form
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="fixed left-1/2 top-1/2 z-[71] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[22px] border-[1.5px] border-line bg-white px-[26px] py-6 shadow-[0_30px_90px_rgba(27,45,69,0.3)]"
      >
        <div className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-purple-ink">New epic</div>
        <div className="mt-1 text-[20px] font-extrabold text-ink">What is being built?</div>
        <div className="mt-1 text-[13.5px] text-ink-2">Describe the requirement. Goals and dates are planned per sprint.</div>
        <label className="mt-[18px] block">
          <span className={labelCls}>Name *</span>
          <input {...register('name')} autoFocus placeholder="e.g. Admin portal" className={fieldCls} />
        </label>
        <label className="mt-3.5 block">
          <span className={labelCls}>Requirement *</span>
          <textarea
            {...register('story')}
            rows={6}
            placeholder="What the client needs, scope, constraints, links to specs…"
            className={fieldCls + ' resize-y leading-[1.55]'}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" onClick={close} className="h-[38px] cursor-pointer rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink">
            Cancel
          </button>
          <button type="submit" className="h-[38px] cursor-pointer rounded-[10px] border-0 bg-blue px-[18px] text-[13.5px] font-bold text-white" style={{ opacity: ok ? 1 : 0.45 }}>
            Create epic
          </button>
        </div>
      </form>
    </>
  )
}
