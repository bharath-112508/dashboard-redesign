/** Formatting and date helpers (SPEC §3 "Formats"). Dates are ISO "YYYY-MM-DD". */

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const ISO_DAY = /^\d{4}-\d\d-\d\d/;
const at = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

/** Whole days from b to a (a − b). */
export function diff(a: string, b: string): number {
  return Math.round((at(a).getTime() - at(b).getTime()) / 864e5);
}

/** ISO day plus n days. */
export function addD(iso: string, n: number): string {
  const d = at(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "10 Oct" (non-ISO input is returned as is). */
export function fmt(iso?: string | null): string {
  if (!iso || !ISO_DAY.test(iso)) return iso ?? '';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${+d} ${MON[+m - 1]}`;
}

/** "10 Oct 2026". */
export function fmtY(iso?: string | null): string {
  if (!iso || !ISO_DAY.test(iso)) return iso ?? '';
  return `${fmt(iso)} ${iso.slice(0, 4)}`;
}

/** "Sat" */
export function dow(iso: string): string {
  return DOW[at(iso).getUTCDay()];
}

/** "Sat 10 Oct" */
export function fmtL(iso?: string | null): string {
  return iso && ISO_DAY.test(iso) ? `${dow(iso)} ${fmt(iso)}` : '';
}

/** "5 Oct – 18 Oct" */
export function fmtRange(a: string, b: string): string {
  return `${fmt(a)} – ${fmt(b)}`;
}

/** Minutes → "1h 30m", "45m", "0h". */
export function hm(min?: number | null): string {
  const m = Math.round(min || 0);
  const H = Math.floor(m / 60);
  const M = m % 60;
  return (H ? `${H}h` : '') + (H && M ? ' ' : '') + (M ? `${M}m` : '') || '0h';
}

/** Initials, max 2 letters. */
export function ini(name?: string | null): string {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** Monday of the week of iso. */
export function monday(iso: string): string {
  const d = at(iso).getUTCDay();
  return addD(iso, -((d + 6) % 7));
}

/**
 * DevOps date for display (A-14: stored ISO). "2026-10-12T07:00" → "12 Oct 2026, 07:00";
 * "2026-10-12" → "12 Oct 2026".
 */
export function dvDate(iso?: string | null): string {
  if (!iso || !ISO_DAY.test(iso)) return iso ?? '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  const time = iso.length > 10 ? iso.slice(11, 16) : '';
  return `${d} ${MON[+m - 1]} ${y}${time ? `, ${time}` : ''}`;
}

/** Short DevOps date "12 Oct, 07:00" (board meta). */
export function dvShort(iso?: string | null): string {
  if (!iso || !ISO_DAY.test(iso)) return iso ?? '';
  const time = iso.length > 10 ? iso.slice(11, 16) : '';
  return `${fmt(iso)}${time ? `, ${time}` : ''}`;
}

/** "1 ticket" / "3 tickets". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** CSV text from rows (quotes cells with , " or newlines). */
export function csv(rows: (string | number | boolean | null | undefined)[][]): string {
  return rows
    .map((r) =>
      r
        .map((x) => {
          const s = String(x ?? '');
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(','),
    )
    .join('\n');
}

/** Stable small hash (company tile colour, demo password hash). */
export function hash(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Demo password hash stored as `pwHash` (V-04). Not cryptographic: the app has no
 * server and keeps everything on the device.
 */
export function hashPw(pw: string): string {
  return `h${hash(`vt:${pw}`).toString(16)}${hash(`${pw}:vt`).toString(16)}`;
}
