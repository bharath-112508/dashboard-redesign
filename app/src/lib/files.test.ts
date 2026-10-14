import { describe, expect, it } from 'vitest'
import { safeHref } from './files'

describe('safeHref', () => {
  it('lets web links, uploaded blobs and attached files through, and nothing that runs script', () => {
    for (const ok of ['https://x.io/a', 'http://x.io', 'blob:https://x.io/1', 'data:image/png;base64,AA', 'data:application/pdf;base64,AA', 'mailto:a@x.io'])
      expect(safeHref(ok)).toBe(ok)
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '//evil.io', ''])
      expect(safeHref(bad)).toBeUndefined()
  })
})
