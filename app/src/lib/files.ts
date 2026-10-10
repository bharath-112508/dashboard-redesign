import type { ChatFile } from '../api/types'
import { fileSize } from '../domain/tasks'

/** Browsers can only keep small files in local storage, so larger ones keep their name but can't be opened. */
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
