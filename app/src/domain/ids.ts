/** A new record id: the prefix, a time part and a random part, so two tabs never pick the same one. */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The website as shown and stored: no protocol, no trailing slash ("https://Daco.no/" → "Daco.no"). */
export const normalizeWebsite = (v: string) => v.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
