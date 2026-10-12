/** Formatters ported from the prototype (DATA.md §2 "Formatters"). All dates are ISO days. */

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

/** Days from b to a (a − b). */
export function diff(a: string, b: string): number {
  return Math.round((noon(a).getTime() - noon(b).getTime()) / 864e5);
}

/** Add n days to an ISO day. */
export function addD(iso: string, n: number): string {
  const d = noon(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "2026-10-10" → "10 Oct" ('' for ''). */
export function sh(iso: string): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/** "2026-03-31" → "31 Mar 2027"-style date with year. */
export function shY(iso: string): string {
  if (!iso) return '';
  return `${sh(iso)} ${iso.slice(0, 4)}`;
}

/** Weekday short name, e.g. "Sat". */
export function dow(iso: string): string {
  return DOW[noon(iso).getUTCDay()];
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(iso: string): number {
  return noon(iso).getUTCDay();
}

/** Hours as "Xh Ym": 1.5 → "1h 30m", 0 → "0h". */
export function hm(n: number): string {
  const total = Math.round(n * 60);
  const H = Math.floor(total / 60);
  const M = total % 60;
  const out = (H ? `${H}h` : '') + (M ? `${H ? ' ' : ''}${M}m` : '');
  return out || '0h';
}

/** Initials of up to two words: "Bhavana P" → "BP". */
export function ini(name: string | undefined | null): string {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/** "24 Oct" or "24 Oct – 25 Oct" for a from/to pair. */
export function dateRange(from: string, to: string): string {
  return sh(from) + (to !== from ? ` – ${sh(to)}` : '');
}

/** "1 day" / "3 days" inclusive between two ISO days. */
export function dayCount(from: string, to: string): string {
  const n = diff(to, from) + 1;
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** Simple plural: plural(2, 'ticket') → "2 tickets". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
