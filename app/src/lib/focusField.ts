/**
 * Scrolls a field into view inside its scrolling panel, focuses it and
 * briefly flashes it (or its [data-fx] box) blue.
 */
export const focusField = (id: string) => {
  setTimeout(() => {
    const el = document.getElementById(id)
    if (!el) return
    let p = el.parentElement
    while (p && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement
    if (p) {
      const r = el.getBoundingClientRect()
      const pr = p.getBoundingClientRect()
      p.scrollTop += r.top - pr.top - 120
    }
    try {
      el.focus()
    } catch {
      // ignore
    }
    const box = (el.closest('[data-fx]') as HTMLElement | null) || el
    box.animate?.(
      [{ boxShadow: '0 0 0 4px rgba(72,112,232,0.5)' }, { boxShadow: '0 0 0 0 rgba(72,112,232,0)' }],
      { duration: 1400, easing: 'ease-out' },
    )
  }, 40)
}
