import { useState, type CSSProperties } from 'react'
import { useSend } from '../../api/queries'
import type { DvProject } from '../../api/devops/types'
import { useDv } from './ctx'
import {
  dayOf,
  DV_ME,
  FIELD_LABEL,
  fieldOptions,
  fieldValue,
  fmtD,
  fmtDay,
  ownerColor,
  relD,
  tone,
  type FieldKey,
} from './model'
import { Caret, GlassMenu, PrioIcon, Switch } from './ui'

const DETAIL_KEYS: FieldKey[] = ['infra', 'prio', 'from', 'act', 'deploy', 'depType', 'dev', 'owner']

const card = 'rounded-[14px] bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)]'

/** A Details row: a label and a coloured pill that opens a menu. */
export function FieldPill({
  k,
  p,
  menuUp = false,
  ddKey,
  onAdd,
  zMenu = 40,
}: {
  k: FieldKey
  p: DvProject
  menuUp?: boolean
  ddKey?: string
  onAdd?: () => void
  zMenu?: number
}) {
  const { db, dd, setDd, setField } = useDv()
  const s = db.settings
  const id = ddKey || k
  const open = dd === id
  const value = fieldValue(k, p, s)
  const own = k === 'owner' || k === 'devOwner'
  const [tC, tBg] = own ? ['#1B2D45', '#E7EEFB'] : tone(value)
  const label = FIELD_LABEL[k]
  return (
    <div className="relative flex-none">
      <button
        type="button"
        onClick={() => setDd(open ? null : id)}
        className="flex max-w-[160px] cursor-pointer items-center gap-1.5 rounded-md border-0 py-[5px] pl-[11px] pr-1.5 text-[12px] font-semibold transition-shadow duration-150 hover:![box-shadow:var(--hv)]"
        style={
          {
            background: tBg,
            color: tC,
            boxShadow: open ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1px rgba(0,0,0,0.06)',
            '--hv': `0 0 0 1.5px ${tC}`,
          } as CSSProperties
        }
      >
        {own && (
          <span
            className="-ml-1.5 flex size-[18px] flex-none items-center justify-center rounded-[5px] text-[9px] font-semibold text-white"
            style={{ background: ownerColor(value) }}
          >
            {value !== 'Unassigned' ? value[0] : '–'}
          </span>
        )}
        {k === 'prio' && <PrioIcon p={value} size={14} sw={2.2} style={{ marginLeft: -3 }} />}
        <span className="min-w-0 truncate whitespace-nowrap">{value}</span>
        <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-white/75">
          <Caret />
        </span>
      </button>
      {open && (
        <GlassMenu
          title={label}
          up={menuUp}
          z={zMenu}
          onClose={() => setDd(null)}
          addLabel={'New ' + label.toLowerCase()}
          onAdd={
            onAdd
              ? () => {
                  setDd(null)
                  onAdd()
                }
              : undefined
          }
          options={fieldOptions(k, p, s).map(o => {
            const on = o === value
            return {
              label: o,
              on,
              ...(own
                ? { avatar: { i: o !== 'Unassigned' ? o[0] : '–', bg: ownerColor(o) } }
                : { dot: [tone(o)[0], tone(o)[1]] as [string, string] }),
              pick: () => {
                setDd(null)
                if (!on) setField(p, k, o)
              },
            }
          })}
        />
      )}
    </div>
  )
}

/** "+ New …" inline form under a Details row. */
export function NewOptionForm({ k, p, onDone }: { k: FieldKey; p: DvProject; onDone: () => void }) {
  const { setField, setChg } = useDv()
  const send = useSend()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const save = () => {
    const t = name.trim()
    if (!t) return
    if (k === 'infra') {
      send({ type: 'devops.option.add', field: 'infra', value: t, desc: desc.trim() })
      setChg({ key: p.key, to: t, note: desc.trim(), due: p.initDue || '', start: '' })
    } else {
      send({ type: 'devops.option.add', field: k, value: t })
      setField(p, k, t)
    }
    onDone()
  }
  const label = FIELD_LABEL[k].toLowerCase()
  return (
    <div className={k === 'devOwner' ? '' : 'px-3.5 pb-3'}>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            e.stopPropagation()
            onDone()
          }
        }}
        placeholder={k === 'devOwner' ? 'Name' : 'New ' + label}
        className="w-full rounded-[9px] border-0 bg-canvas px-[9px] py-[7px] text-[13px] text-ink outline-0 shadow-[0_0_0_2px_#4870E8]"
      />
      {k === 'infra' && (
        <>
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            rows={3}
            placeholder="Description (saved to Settings, reused by every project)"
            className="mt-2 w-full resize-y rounded-[9px] border-0 bg-canvas px-[9px] py-[7px] text-[12px] leading-[1.45] text-ink outline-0"
          />
          <div className="mt-1 text-[11px] text-muted">Added to Settings → Statuses</div>
        </>
      )}
      <div className="mt-2 flex justify-end gap-3">
        <button type="button" onClick={onDone} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted">
          Cancel
        </button>
        <button type="button" onClick={save} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-blue-ink">
          Add &amp; set
        </button>
      </div>
    </div>
  )
}

type DateKey = 'initDue' | 'latestDue' | 'actDate' | 'reminder' | 'nextStart' | 'devDue'
const DATE_FIELDS: [DateKey, string][] = [
  ['initDue', 'Initial due date'],
  ['latestDue', 'Estimated deployment'],
  ['actDate', 'Current action date'],
  ['reminder', 'Next reminder'],
  ['nextStart', 'Next step start'],
  ['devDue', 'Dev phase due date'],
]

/** The right-hand column of the project panel: Details and Dates. */
export function Sidebar({ p }: { p: DvProject }) {
  const { db, update } = useDv()
  const s = db.settings
  const [adding, setAdding] = useState<FieldKey | null>(null)
  const [editField, setEditField] = useState<DateKey | null>(null)
  const [fieldDraft, setFieldDraft] = useState('')

  const hd = p.latestDue || p.initDue
  const [hRel, hRelC] = relD(dayOf(hd), true)

  const saveDate = () => {
    const k = editField
    if (!k) return
    const t = fieldDraft.trim()
    if (t) {
      const label = DATE_FIELDS.find(f => f[0] === k)![1]
      const old = p[k] ? fmtD(p[k]) : '—'
      if (fmtD(t) !== old) {
        const patch: Partial<DvProject> = { [k]: t, updatedBy: DV_ME }
        if (k === 'latestDue') patch.moved = null
        update(p.key, patch, { type: 'Field change', text: label + ' changed to ' + fmtD(t), detail: 'Was: ' + old })
      }
    }
    setEditField(null)
  }

  return (
    <div className="flex-[0_0_308px] overflow-y-auto border-l-[0.5px] border-black/[0.06] bg-canvas px-[18px] pb-7 pt-16">
      <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Details</div>
      <div className={card}>
        {DETAIL_KEYS.map((k, i) => (
          <div key={k} style={{ borderTop: i ? '0.5px solid rgba(0,0,0,0.07)' : 'none' }}>
            <div className="flex min-h-[46px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3">
              <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] text-ink-2">{FIELD_LABEL[k]}</span>
              <FieldPill k={k} p={p} menuUp={i >= 4} onAdd={k === 'act' ? undefined : () => setAdding(k)} />
            </div>
            {k === 'depType' && (
              <div className="flex min-h-[46px] items-center justify-between gap-2.5 border-t-[0.5px] border-black/[0.07] py-2 pl-3.5 pr-3">
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-2">CI/CD</div>
                  <div className="text-[11px] text-muted">{p.cicd ? 'Pipeline set up' : 'No pipeline'}</div>
                </div>
                <Switch
                  label="Toggle CI/CD"
                  on={!!p.cicd}
                  onClick={() =>
                    update(p.key, { cicd: !p.cicd, updatedBy: DV_ME }, { type: 'Field change', text: 'CI/CD ' + (!p.cicd ? 'turned on' : 'turned off') })
                  }
                />
              </div>
            )}
            {adding === k && <NewOptionForm k={k} p={p} onDone={() => setAdding(null)} />}
          </div>
        ))}
      </div>

      <div className="px-1 pb-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Dates</div>
      <div className={`${card} px-3.5 pb-3.5 pt-4`}>
        <div className="text-[12px] text-muted">Estimated deployment</div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
          <span className="tnum text-[24px] font-bold tracking-[-0.02em]">{hd ? fmtDay(hd) : 'Not set'}</span>
          <span className="text-[12px] font-medium" style={{ color: hRelC }}>
            {hd ? hRel : ''}
          </span>
        </div>
        {!!(p.moved && p.latestDue) && (
          <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
            <span className="rounded-[5px] bg-amber-soft px-[7px] py-0.5 font-semibold text-amber-ink">{p.moved}</span>
            from initial {p.initDue ? fmtDay(p.initDue) : '—'}
          </div>
        )}
        {p.reason && (
          <div className="mt-2.5 border-t-[0.5px] border-black/[0.07] pt-2.5 text-[12px] leading-[1.45] text-muted">{p.reason}</div>
        )}
      </div>
      <div className={`${card} mt-2.5`}>
        {DATE_FIELDS.map(([k, label], i) => {
          const raw = p[k]
          const locked = (k === 'initDue' && s.rules.lockInitial) || (k === 'devDue' && s.rules.lockDevDue)
          const [rel, relC] = relD(dayOf(raw), k === 'reminder' || k === 'latestDue' || k === 'devDue')
          const editing = !locked && editField === k
          return (
            <div key={k} style={{ borderTop: i ? '0.5px solid rgba(0,0,0,0.07)' : 'none' }}>
              <div
                onClick={() => {
                  if (locked) return
                  setEditField(k)
                  setFieldDraft(dayOf(raw) || '')
                }}
                className="flex min-h-[50px] items-center justify-between gap-2.5 px-3.5 py-2"
                style={{ cursor: locked ? 'default' : 'pointer' }}
                onMouseEnter={e => !locked && (e.currentTarget.style.background = '#EEF3FB')}
                onMouseLeave={e => (e.currentTarget.style.background = '')}
              >
                <div className="min-w-0">
                  <div className="text-[13px] text-ink-2">{label}</div>
                  {locked && <div className="mt-px text-[11px] text-slate">Fixed</div>}
                </div>
                <div className="flex-none text-right">
                  <div className="tnum text-[13px] font-semibold" style={{ color: raw ? '#1B2D45' : '#56657A' }}>
                    {raw ? fmtDay(raw) : 'Not set'}
                  </div>
                  <div className="mt-px text-[11px] font-medium" style={{ color: relC }}>
                    {rel}
                  </div>
                </div>
              </div>
              {editing && (
                <div className="px-3.5 pb-3">
                  <input
                    type="date"
                    value={fieldDraft}
                    onChange={e => setFieldDraft(e.target.value)}
                    className="w-full rounded-[9px] border-0 bg-canvas px-[9px] py-[7px] text-[13px] text-ink outline-0 shadow-[0_0_0_2px_#4870E8]"
                  />
                  <div className="mt-2 flex justify-end gap-3">
                    <button type="button" onClick={() => setEditField(null)} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-muted">
                      Cancel
                    </button>
                    <button type="button" onClick={saveDate} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-blue-ink">
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="px-1 pt-3.5 text-[12px] text-slate">Last updated by {p.updatedBy || '—'}</div>
    </div>
  )
}
