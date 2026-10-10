/** Logo uploads: what is accepted, how large, and how the picture is stored. */

export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const
export const LOGO_MAX_BYTES = 2 * 1024 * 1024
/** Logos are stored at this size or smaller, as PNG. */
export const LOGO_MAX_PX = 200

/** The message for a file that cannot be a logo, or null when it can. */
export const logoProblem = (file: { type: string; size: number; name: string }): string | null => {
  const typeOk = (LOGO_TYPES as readonly string[]).includes(file.type) || (!file.type && /\.(png|jpe?g|webp|svg)$/i.test(file.name))
  if (!typeOk) return 'Choose a PNG, JPEG, WebP or SVG image.'
  if (file.size > LOGO_MAX_BYTES) return 'The logo is larger than 2 MB. Choose a smaller file.'
  if (file.size === 0) return 'The file is empty. Choose another image.'
  return null
}

/**
 * Reads an image file and returns it as a PNG data URL, scaled to fit
 * LOGO_MAX_PX. Rejects when the browser cannot decode the file.
 */
export const readLogo = (file: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      // An SVG without a size reports 0; a square box then keeps it visible.
      const w = img.naturalWidth || LOGO_MAX_PX
      const h = img.naturalHeight || LOGO_MAX_PX
      const scale = Math.min(1, LOGO_MAX_PX / Math.max(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('no canvas'))
        return
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('unreadable image'))
    }
    img.src = url
  })
