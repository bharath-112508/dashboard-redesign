import { useState } from 'react'
import { useAccess, useSendAsync } from '../../api/queries'
import { apiMode } from '../../api/http/config'
import { usePeople } from '../../api/people/directory'
import { ROLE_LABEL } from '../../api/session/access'
import type { Role } from '../../api/types'
import { ROLE_BLURB, ROLE_ORDER, PERMISSIONS, PERMISSION_GROUPS, isClientRoleKey } from '../../api/users/access'
import { useToast } from '../shell/toast'
import { btnPrimary, card, field } from './ui'

interface Props {
  /** Super admins and admins can change the matrix and add developer types. */
  canEdit: boolean
}

const COL = 'minmax(230px,1fr)'

/** Role cards, the permission matrix (super admin column locked) and developer types. */
export function RolesTab({ canEdit: mayEdit }: Props) {
  // API mode: what a role may do is set on the server, so the matrix is shown for reference only.
  const canEdit = mayEdit && !apiMode
  const people = usePeople().data ?? []
  const access = useAccess().data
  const send = useSendAsync()
  const show = useToast()
  const [selRole, setSelRole] = useState<Role>('admin')
  const [newType, setNewType] = useState('')
  const [typeError, setTypeError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!access) return <p className="text-[14px] text-slate">Loading roles…</p>

  const togglePerm = async (role: Role, perm: string, on: boolean) => {
    setError(null)
    try {
      await send({ type: 'access.setPerm', role, perm, on })
    } catch {
      setError('That change could not be saved. Try again.')
    }
  }

  const addType = async () => {
    const name = newType.trim()
    if (!name) return setTypeError('Enter a name for the developer type.')
    if (access.devTypes.some(d => d.toLowerCase() === name.toLowerCase())) return setTypeError('That type is already in the list.')
    setTypeError(null)
    try {
      await send({ type: 'access.addDevType', name })
      setNewType('')
      show(`Added developer type ${name}.`)
    } catch {
      setTypeError('That type could not be added. Try again.')
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] leading-[1.55] text-slate">
        {apiMode
          ? 'Shown for reference. What each role can do is set by the role itself on the server, so these boxes cannot be changed here.'
          : 'Changes here are saved for the team, but they do not change which pages a role can open. Page access follows the fixed role map.'}
        {!apiMode && !canEdit && ' You can view this matrix; only a super admin or admin can change it.'}
      </p>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ROLE_ORDER.map(r => {
          const on = r === selRole
          const count = people.filter(p => p.role === r).length
          const granted = access.perms[r]?.length ?? 0
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              onClick={() => setSelRole(r)}
              className={`rounded-2xl border-[1.5px] p-4 text-left ${on ? 'border-blue bg-sky' : 'border-line-2 bg-white hover:border-blue'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[14.5px] font-bold text-ink">{ROLE_LABEL[r]}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${isClientRoleKey(r) ? 'bg-sky-2 text-blue-ink' : 'bg-ink text-white'}`}>
                  {isClientRoleKey(r) ? 'Client' : 'Viljetech'}
                </span>
              </div>
              <p className="mt-1.5 min-h-[40px] text-[12.5px] leading-[1.45] text-slate">{ROLE_BLURB[r]}</p>
              <div className="mt-2 flex gap-3 text-[12px] font-semibold text-ink-2">
                <span>{granted} of {PERMISSIONS.length} permissions</span>
                <span>{count} {count === 1 ? 'user' : 'users'}</span>
              </div>
            </button>
          )
        })}
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-3 px-4 py-3">
          <div>
            <h2 className="text-[15px] font-bold text-ink">Permissions</h2>
            <p className="text-[12px] text-slate">Selected: {ROLE_LABEL[selRole]}. Super admin always has every permission.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[860px]" role="table" aria-label="Permission matrix">
            <div role="row" className="grid items-center bg-canvas px-4 py-2 text-[11.5px] font-bold uppercase tracking-[0.05em] text-slate" style={{ gridTemplateColumns: `${COL} repeat(${ROLE_ORDER.length}, minmax(96px,1fr))` }}>
              <div role="columnheader">Permission</div>
              {ROLE_ORDER.map(r => (
                <div role="columnheader" key={r} className={`px-1 text-center ${r === selRole ? 'text-blue-ink' : ''}`}>
                  {ROLE_LABEL[r]}
                </div>
              ))}
            </div>
            {PERMISSION_GROUPS.map(group => (
              <div key={group}>
                <div className="px-4 pb-1 pt-3 text-[11.5px] font-bold uppercase tracking-[0.06em] text-slate">{group}</div>
                {PERMISSIONS.filter(p => p.group === group).map(perm => (
                  <div
                    role="row"
                    key={perm.id}
                    className="grid items-center border-t border-line-3 px-4 py-2 text-[13px]"
                    style={{ gridTemplateColumns: `${COL} repeat(${ROLE_ORDER.length}, minmax(96px,1fr))` }}
                  >
                    <div role="cell" className="min-w-0 pr-3">
                      <div className="font-semibold text-ink">{perm.label}</div>
                      <div className="text-[12px] text-slate">{perm.hint}</div>
                    </div>
                    {ROLE_ORDER.map(r => {
                      const on = r === 'super' ? true : !!access.perms[r]?.includes(perm.id)
                      const cell = (
                        <span
                          aria-hidden="true"
                          className={`grid size-[22px] place-items-center rounded-[6px] text-[12px] font-extrabold ${
                            on ? 'bg-blue text-white' : 'border-[1.5px] border-faint bg-white text-transparent'
                          }`}
                        >
                          ✓
                        </span>
                      )
                      const column = r === selRole ? 'bg-sky/60' : ''
                      if (r === 'super') {
                        return (
                          <div role="cell" key={r} className={`flex justify-center py-1 ${column}`}>
                            <span
                              className="grid cursor-default place-items-center opacity-70"
                              title="Super admin always has every permission"
                              aria-label={`${ROLE_LABEL[r]}: ${perm.label}, always on`}
                            >
                              {cell}
                            </span>
                          </div>
                        )
                      }
                      return (
                        <div role="cell" key={r} className={`flex justify-center py-1 ${column}`}>
                          <button
                            type="button"
                            aria-pressed={on}
                            aria-label={`${ROLE_LABEL[r]}: ${perm.label}`}
                            title={`${ROLE_LABEL[r]}: ${perm.label}`}
                            disabled={!canEdit}
                            onClick={() => togglePerm(r, perm.id, !on)}
                            className="cursor-pointer rounded-[6px] p-0 disabled:cursor-default"
                          >
                            {cell}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        {error && <p role="alert" className="border-t border-line-3 px-4 py-2.5 text-[13px] font-semibold text-red">{error}</p>}
      </div>

      <div className={`${card} p-4`}>
        <h2 className="text-[15px] font-bold text-ink">Developer types</h2>
        <p className="mt-0.5 text-[12px] text-slate">A discipline, not a role. Shown as the User type on the user form.</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {access.devTypes.map(d => (
            <span key={d} className="rounded-full border-[1.5px] border-line bg-white px-3 py-1 text-[12.5px] font-semibold text-ink-2">
              {d}
            </span>
          ))}
        </div>
        {mayEdit && (
          <div className="mt-3 flex max-w-[460px] flex-wrap gap-2">
            <input
              className={`${field} flex-1`}
              aria-label="New developer type"
              placeholder="e.g. Data"
              value={newType}
              onChange={e => setNewType(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addType()
                }
              }}
            />
            <button type="button" className={btnPrimary.replace('px-5', 'px-4')} onClick={addType}>
              + Add
            </button>
          </div>
        )}
        {typeError && <p role="alert" className="mt-2 text-[12.5px] font-semibold text-red">{typeError}</p>}
      </div>
    </div>
  )
}
