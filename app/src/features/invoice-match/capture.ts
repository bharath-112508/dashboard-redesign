/**
 * Screen capture for "Send feedback", without a screenshot library.
 *
 * Snippet and Screenshot copy the element's DOM with every computed style
 * written inline, draw the copy into an SVG <foreignObject>, and paint that
 * onto a canvas. Web fonts and cross-origin images are not carried over (the
 * copy falls back to system fonts), which is fine for a bug report.
 * Video uses the browser's own screen recording (getDisplayMedia + MediaRecorder).
 */

export type Rect = { x: number; y: number; w: number; h: number }

const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TEMPLATE', 'IFRAME', 'NOSCRIPT'])

/** A copy of `src` with computed styles inline. Elements `ignore` matches are left out. */
const copyStyled = (src: Node, ignore: (el: Element) => boolean): Node | null => {
  if (src.nodeType === Node.TEXT_NODE) return src.cloneNode()
  if (src.nodeType !== Node.ELEMENT_NODE) return null
  const el = src as Element
  if (SKIP.has(el.tagName) || ignore(el)) return null
  const cs = getComputedStyle(el)
  if (cs.display === 'none') return null

  // Media and canvases can't be serialised; a dark box keeps the layout.
  if (el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement) {
    const box = document.createElement('div')
    box.setAttribute('style', `width:${(el as HTMLElement).offsetWidth}px;height:${(el as HTMLElement).offsetHeight}px;background:#111827;border-radius:${cs.borderRadius}`)
    return box
  }

  const copy = el.cloneNode(false) as Element
  let css = ''
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i]
    css += `${p}:${cs.getPropertyValue(p)};`
  }
  copy.setAttribute('style', css)
  copy.removeAttribute('class')
  if (el instanceof HTMLInputElement) copy.setAttribute('value', el.value)
  if (el instanceof HTMLTextAreaElement) copy.textContent = el.value
  if (el instanceof HTMLSelectElement) {
    const opt = el.options[el.selectedIndex]
    copy.textContent = ''
    if (opt) copy.appendChild(opt.cloneNode(true))
  }
  if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLSelectElement)) {
    el.childNodes.forEach(ch => {
      const c = copyStyled(ch, ignore)
      if (c) copy.appendChild(c)
    })
  }
  return copy
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The page could not be drawn'))
    img.src = src
  })

/**
 * A PNG data URL of `el`, or of the part of it inside `rect` (in CSS pixels
 * from the element's top left). Rejects when the browser cannot draw it.
 */
export async function captureElement(
  el: HTMLElement,
  rect: Rect | null,
  opts: { ignore?: (el: Element) => boolean; background?: string } = {},
): Promise<string> {
  const W = el.offsetWidth
  const H = el.offsetHeight
  const copy = copyStyled(el, opts.ignore ?? (() => false)) as HTMLElement | null
  if (!copy) throw new Error('Nothing to capture')
  // The copy sits at the top left of the image, whatever its place on the page.
  copy.style.margin = '0'
  copy.style.position = 'relative'
  copy.style.left = '0'
  copy.style.top = '0'
  copy.style.transform = 'none'
  copy.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  const xml = new XMLSerializer().serializeToString(copy)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<foreignObject x="0" y="0" width="${W}" height="${H}">${xml}</foreignObject></svg>`
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg))

  const R = rect ?? { x: 0, y: 0, w: W, h: H }
  const k = Math.min(2, window.devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(R.w * k))
  canvas.height = Math.max(1, Math.round(R.h * k))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No canvas')
  ctx.fillStyle = opts.background ?? '#FFFFFF'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, R.x, R.y, R.w, R.h, 0, 0, canvas.width, canvas.height)
  // Throws if the browser tainted the canvas (Safari does for foreignObject).
  return canvas.toDataURL('image/png')
}

export const blobToDataUrl = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const rd = new FileReader()
    rd.onload = () => resolve(String(rd.result))
    rd.onerror = () => reject(rd.error)
    rd.readAsDataURL(b)
  })

export type Recording = { blob: Blob; ext: string; secs: number }

export type RecordFail = { failMsg: string }

/** Video formats to try, best first. */
const MIME = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

/** Longest recording, as in the prototype. */
export const MAX_RECORD_MS = 120_000

/**
 * Starts a screen recording. Resolves with a stop function, or with the
 * message to show when the browser has no screen recording or the person
 * refused it. `onDone` gets the recording when it stops (Stop, the browser's
 * own "Stop sharing", or the two-minute limit).
 */
export async function startRecording(onDone: (r: Recording) => void): Promise<{ stop: () => void } | RecordFail> {
  const md = navigator.mediaDevices
  if (!md || !md.getDisplayMedia || typeof MediaRecorder === 'undefined')
    return { failMsg: 'This browser cannot record the screen. Record with your computer and use Upload instead.' }
  let stream: MediaStream
  try {
    stream = await md.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
      // Chrome: offer this tab first.
      ...({ preferCurrentTab: true, selfBrowserSurface: 'include' } as object),
    })
  } catch (e) {
    return {
      failMsg:
        e instanceof DOMException && e.name === 'NotAllowedError'
          ? 'Screen recording was blocked or cancelled. You can upload a video instead.'
          : 'Screen recording is not available here. You can upload a video instead.',
    }
  }
  const mt = MIME.find(x => MediaRecorder.isTypeSupported?.(x)) ?? ''
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(stream, mt ? { mimeType: mt, videoBitsPerSecond: 900_000 } : {})
  } catch {
    stream.getTracks().forEach(t => t.stop())
    return { failMsg: 'Screen recording is not available here. You can upload a video instead.' }
  }
  const chunks: Blob[] = []
  const t0 = Date.now()
  rec.ondataavailable = e => {
    if (e.data && e.data.size) chunks.push(e.data)
  }
  rec.onstop = () => {
    clearTimeout(limit)
    stream.getTracks().forEach(t => t.stop())
    const type = mt.split(';')[0] || 'video/webm'
    onDone({ blob: new Blob(chunks, { type }), ext: /mp4/.test(type) ? 'mp4' : 'webm', secs: Math.round((Date.now() - t0) / 1000) })
  }
  const stop = () => {
    if (rec.state !== 'inactive') rec.stop()
  }
  stream.getVideoTracks()[0]?.addEventListener('ended', stop)
  const limit = setTimeout(stop, MAX_RECORD_MS)
  rec.start(1000)
  return { stop }
}
