import { decimal } from './week'

/**
 * File exports for My timesheet: CSV, Excel (.xlsx) and a PDF report. Each one
 * takes the rows the History view shows. No libraries: the .xlsx is a zip of
 * XML parts and the PDF is written with the built-in Helvetica font.
 */

/** One line of an export. `billable` is 'Yes', 'No' or 'Split' (both billable and non-billable hours). */
export interface ExportRow {
  date: string
  project: string
  type: string
  ticket: string
  task: string
  hours: number
  bill: number
  non: number
  billable: 'Yes' | 'No' | 'Split'
  note: string
}

export const CSV_HEADERS = ['Date', 'Project', 'Type', 'Ticket', 'Task', 'Hours', 'Billable', 'Note'] as const

/** Quotes a CSV field when it holds a comma, a quote or a line break; doubles inner quotes. */
export const csvField = (v: string): string => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)

export const toCsv = (rows: ExportRow[]): string => {
  const lines = [CSV_HEADERS.join(',')]
  for (const r of rows)
    lines.push(
      [r.date, r.project, r.type, r.ticket, r.task, decimal(r.hours), r.billable, r.note].map(csvField).join(','),
    )
  return lines.join('\r\n') + '\r\n'
}

// ---------- Excel (.xlsx)

const xmlEscape = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const colName = (i: number) => String.fromCharCode(65 + i) // up to 26 columns

type Cell = string | number | null

const sheetXml = (rows: Cell[][], boldRows: number[]): string => {
  const out = rows.map((row, r) => {
    const cells = row
      .map((v, c) => {
        const ref = colName(c) + (r + 1)
        const s = boldRows.includes(r) ? ' s="1"' : ''
        if (v === null || v === '') return ''
        if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`
        return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`
      })
      .join('')
    return `<row r="${r + 1}">${cells}</row>`
  })
  return (
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    '<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/><col min="3" max="3" width="12" customWidth="1"/>' +
    '<col min="4" max="4" width="11" customWidth="1"/><col min="5" max="5" width="40" customWidth="1"/><col min="6" max="8" width="14" customWidth="1"/>' +
    '<col min="9" max="9" width="60" customWidth="1"/></cols>' +
    `<sheetData>${out.join('')}</sheetData></worksheet>`
  )
}

/** The workbook rows: the header, one row per entry, then a totals row. */
export const xlsxRows = (rows: ExportRow[]): { cells: Cell[][]; bold: number[] } => {
  const header = ['Date', 'Project', 'Type', 'Ticket', 'Task', 'Hours', 'Billable hours', 'Non-billable hours', 'Note']
  const body: Cell[][] = rows.map(r => [
    r.date,
    r.project,
    r.type,
    r.ticket,
    r.task,
    round2(r.hours),
    round2(r.bill),
    round2(r.non),
    r.note,
  ])
  const sum = (f: (r: ExportRow) => number) => round2(rows.reduce((a, r) => a + f(r), 0))
  const total: Cell[] = ['Total', '', '', '', '', sum(r => r.hours), sum(r => r.bill), sum(r => r.non), '']
  return { cells: [header, ...body, total], bold: [0, body.length + 1] }
}

const round2 = (n: number) => Math.round(n * 100) / 100

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const utf8 = (s: string) => new TextEncoder().encode(s)

/** A zip archive with stored (uncompressed) entries. Enough for an .xlsx. */
export const zip = (files: { name: string; data: Uint8Array }[]): Uint8Array => {
  const locals: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const DATE = (1 << 9) | (1 << 5) | 1 // 1 Jan 2000 (zip's DOS date)
  for (const f of files) {
    const name = utf8(f.name)
    const crc = crc32(f.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, 0, true) // stored
    lv.setUint16(10, 0, true)
    lv.setUint16(12, DATE, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, f.data.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    locals.push(local, f.data)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, DATE, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, f.data.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)
    offset += local.length + f.data.length
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const parts = [...locals, ...central, end]
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0))
  let p = 0
  for (const part of parts) {
    out.set(part, p)
    p += part.length
  }
  return out
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

export const toXlsx = (rows: ExportRow[]): Uint8Array => {
  const { cells, bold } = xlsxRows(rows)
  const files = [
    {
      name: '[Content_Types].xml',
      data: utf8(
        XML_HEAD +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: utf8(
        XML_HEAD +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="My timesheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: utf8(
        XML_HEAD +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
          '</Relationships>',
      ),
    },
    {
      name: 'xl/styles.xml',
      data: utf8(
        XML_HEAD +
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
          '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
          '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
          '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
          '</styleSheet>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(XML_HEAD + sheetXml(cells, bold)) },
  ]
  return zip(files)
}

// ---------- PDF report

/** WinAnsi-safe text: Latin-1 letters stay, the rest becomes "?" or a plain dash. */
const pdfText = (s: string) =>
  s
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')

const pdfEscape = (s: string) => pdfText(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

export interface PdfLine {
  text: string
  font?: 'F1' | 'F2' | 'F3' // Helvetica, Helvetica-Bold, Courier
  size?: number
  gap?: number
}

const PAGE_W = 595
const PAGE_H = 842
const MARGIN = 40

/** Lays lines out on A4 pages (top to bottom) and writes a PDF file. */
export const toPdf = (lines: PdfLine[]): Uint8Array => {
  // Split into pages by height.
  const pages: { ops: string[] }[] = []
  let ops: string[] = []
  let y = PAGE_H - MARGIN
  const flush = () => {
    pages.push({ ops })
    ops = []
    y = PAGE_H - MARGIN
  }
  for (const l of lines) {
    const size = l.size ?? 10
    const lead = size * 1.35 + (l.gap ?? 0)
    if (y - lead < MARGIN) flush()
    y -= lead
    ops.push(`BT /${l.font ?? 'F1'} ${size} Tf ${MARGIN} ${y.toFixed(1)} Td (${pdfEscape(l.text)}) Tj ET`)
  }
  flush()

  // Objects: 1 catalog, 2 pages, 3-5 fonts, then a page and a content stream per page.
  const objs: Uint8Array[] = []
  const add = (s: string | Uint8Array) => {
    objs.push(typeof s === 'string' ? latin1(s) : s)
    return objs.length // object number
  }
  add('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ')
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>')
  pages.forEach((pg, i) => {
    const content = pg.ops.join('\n')
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${7 + i * 2} 0 R >>`,
    )
    add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  })

  // Assemble with a cross-reference table.
  const header = latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
  const chunks: Uint8Array[] = [header]
  const offsets: number[] = []
  let pos = header.length
  objs.forEach((body, i) => {
    offsets.push(pos)
    const head = latin1(`${i + 1} 0 obj\n`)
    const tail = latin1('\nendobj\n')
    chunks.push(head, body, tail)
    pos += head.length + body.length + tail.length
  })
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`
  chunks.push(latin1(xref))
  const out = new Uint8Array(chunks.reduce((a, b) => a + b.length, 0))
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

/** Bytes for a string where each character is one byte (Latin-1). */
const latin1 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** The PDF report: a title, the period, totals per project, then every entry. */
export const pdfLines = (rows: ExportRow[], period: string, who: string): PdfLine[] => {
  const sum = (f: (r: ExportRow) => number) => rows.reduce((a, r) => a + f(r), 0)
  const lines: PdfLine[] = [
    { text: 'My timesheet', font: 'F2', size: 18, gap: 4 },
    { text: `${who} · ${period}`, size: 11 },
    { text: `${rows.length} entries`, size: 9, gap: 10 },
    { text: `Total ${round2(sum(r => r.hours))} h   Billable ${round2(sum(r => r.bill))} h   Non-billable ${round2(sum(r => r.non))} h`, font: 'F2', size: 11, gap: 12 },
    { text: 'Totals by project', font: 'F2', size: 11 },
  ]
  const byProject = new Map<string, number>()
  rows.forEach(r => byProject.set(r.project || 'No project', (byProject.get(r.project || 'No project') ?? 0) + r.hours))
  for (const [name, h] of [...byProject].sort((a, b) => b[1] - a[1]))
    lines.push({ text: `${name.padEnd(60, ' ').slice(0, 60)} ${decimal(h).padStart(8)} h`, font: 'F3', size: 8.5 })
  lines.push({ text: 'Entries', font: 'F2', size: 11, gap: 12 })
  const head = `${'Date'.padEnd(11)}${'Project'.padEnd(28)}${'Ticket'.padEnd(10)}${'Task'.padEnd(34)}${'Hours'.padStart(7)}  ${'Billable'.padEnd(8)}`
  lines.push({ text: head, font: 'F3', size: 8 })
  for (const r of rows) {
    const project = (r.project || 'No project').slice(0, 27)
    const task = (r.task || '').slice(0, 33)
    lines.push({
      text: `${r.date.padEnd(11)}${project.padEnd(28)}${r.ticket.slice(0, 9).padEnd(10)}${task.padEnd(34)}${decimal(r.hours).padStart(7)}  ${r.billable.padEnd(8)}`,
      font: 'F3',
      size: 8,
    })
    if (r.note.trim()) lines.push({ text: `    ${r.note.slice(0, 120)}`, size: 8, font: 'F1' })
  }
  if (!rows.length) lines.push({ text: 'No entries in this period.', size: 10 })
  return lines
}

// ---------- download

/** Starts a browser download of the bytes under `name`. */
export const download = (name: string, bytes: Uint8Array, type: string) => {
  const blob = new Blob([bytes as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
