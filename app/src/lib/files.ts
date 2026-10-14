import type { ChatFile } from '../api/types'
import { fileSize } from '../domain/tasks'

/**
 * Files above this keep their name and size but can't be opened or downloaded. The limit
 * is kept from before attachment contents moved to IndexedDB, so the behaviour stays the same.
 */
const MAX_INLINE = 1.5e6

/** Reads picked or dropped files into attachments with data URLs. */
export const readFiles = (list: FileList | File[] | null | undefined): Promise<ChatFile[]> => {
  const files = [...(list || [])]
  return Promise.all(
    files.map(
      f =>
        new Promise<ChatFile>(resolve => {
          const size = fileSize(f.size)
          if (f.size > MAX_INLINE) {
            resolve({ name: f.name, size, url: '', img: false })
            return
          }
          const rd = new FileReader()
          rd.onload = () => resolve({ name: f.name, size, url: String(rd.result), img: /^image\//.test(f.type) })
          rd.onerror = () => resolve({ name: f.name, size, url: '', img: false })
          rd.readAsDataURL(f)
        }),
    ),
  )
}

export const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(name)

/**
 * A stored link or file address that is safe to open: web links, mail links, uploaded
 * blobs and attached files (data URLs, except HTML pages). Anything that could run
 * script in the app (`javascript:` and the like) gives undefined, so the link is inert.
 */
export const safeHref = (url: string | null | undefined): string | undefined => {
  const u = (url ?? '').trim()
  if (/^data:text\/html/i.test(u)) return undefined
  return /^(https?:\/\/|mailto:|blob:|data:)/i.test(u) ? u : undefined
}
