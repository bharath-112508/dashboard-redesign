import { useRef, useState } from 'react'
import { LogoTile } from '../../components/Bits'
import { errorCls } from '../../components/Dialog'
import { LOGO_MAX_PX, logoProblem, readLogo } from '../../lib/logo'

/**
 * Logo picker: uploads are checked for type and size, then stored as a small
 * PNG. `onChange('')` removes the logo.
 */
export function LogoField({
  name,
  p,
  value,
  onChange,
  size = 64,
  busy = false,
}: {
  name: string
  p: number
  value: string
  onChange: (logo: string) => void | Promise<void>
  size?: number
  busy?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = async (file: File | undefined) => {
    if (!file) return
    const problem = logoProblem(file)
    if (problem) {
      setError(problem)
      return
    }
    try {
      const data = await readLogo(file)
      setError(null)
      await onChange(data)
    } catch {
      setError('This file could not be read as an image. Choose another file.')
    }
  }

  return (
    <div className="flex items-center gap-3.5">
      <LogoTile name={name || 'New company'} p={p} logo={value || undefined} size={size} />
      <div className="min-w-0">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => input.current?.click()}
            className="h-8 cursor-pointer rounded-lg border-[1.5px] border-line bg-white px-3 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink disabled:opacity-60"
          >
            {value ? 'Change logo' : 'Upload logo'}
          </button>
          {value && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null)
                void onChange('')
              }}
              className="h-8 cursor-pointer rounded-lg px-2 text-[12.5px] font-semibold text-red hover:underline disabled:opacity-60"
            >
              Remove
            </button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          aria-label="Company logo file"
          accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          onChange={e => {
            void pick(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <p className="mt-1.5 text-[12px] text-muted">{`PNG, JPEG, WebP or SVG, up to 2 MB. Shown at up to ${LOGO_MAX_PX} px.`}</p>
        {error && (
          <p role="alert" className={`mt-1 ${errorCls}`}>
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
