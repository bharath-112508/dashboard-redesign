/**
 * Colour tokens (mobile-spec-v5 SPEC.md §6.1). Feature code imports these; no raw hex in
 * screens. Tones (`tones.blue` …) are the prototype's `C` palette as {soft, ink, dot}.
 */
export const colors = {
  // ink and blue set (unchanged from v4)
  ink: '#1B2D45',
  ink2: '#22354C',
  ink3: '#3B4A5E',
  faint: '#A9B6C5',
  bg: '#F6F9FC',
  surface: '#FFFFFF',
  overlay: 'rgba(14,22,34,0.42)',
  track: '#EEF3FB',
  trackSoft: '#F1F4F8',

  // lines and rings
  line: '#D6DEE8',
  lineInput: '#C9D2DD',
  ringCard: '#E4EAF0',
  divider: '#EEF3FB',
  handle: '#C9D2DD',

  // surfaces
  segTrack: '#E7ECF2',
  boardCol: '#EDF1F6',
  rowSelected: '#F2F6FE',
  rowPicked: '#EEF3FB',

  // blue
  primary: '#4870E8',
  primaryInk: '#1F3FAF',
  primarySoft: '#E7EEFB',
  brand: '#3A63E0',
  sendOff: '#A9B6C5',

  // red / danger
  red: '#D9534F',
  danger: '#C0392B',
  dangerInk: '#8E2A1F',
  redInk: '#A5302B',
  redSoft: '#FBE7E3',
  dangerRing: '#F0C9B8',
  destructiveBg: '#FBF3EF',
  destructiveInk: '#A5502C',
  errorBg: '#FBF3EF',

  // amber
  amberDot: '#E2B23C',
  amberSoft: '#FBF1D6',
  amberInk: '#7A5C0E',
  noteInk: '#5C4508',

  // green
  green: '#3F9079',
  greenSoft: '#DFF1EA',
  greenInk: '#195040',
  storySoft: '#D6E9E2',

  // violet
  violet: '#9F89E5',
  violetDot: '#7C5CD6',
  violetSoft: '#EEE9FB',
  violetInk: '#5B3FB8',

  // teal, devops, orange
  teal: '#3E908F',
  tealSoft: '#DFF1F0',
  tealInk: '#1F6F6E',
  devopsSoft: '#E6F0F7',
  devopsInk: '#1D5A7A',
  orange: '#D2724A',
  taskSoft: '#DCE5FA',

  // hero variants and specials
  overdueHero: '#FFF5F2',
  maintHero: '#123F3E',
  toastIcon: '#7FD8C9',
  idleHatch: '#F6D2C9',
  idleHatch2: '#FBE7E3',
  uptime: '#4ADE9B',
  clientAvatar: '#56657A',

  white: '#FFFFFF',
  transparent: 'transparent',
} as const;

export type ColorToken = keyof typeof colors;

/** A soft / ink / dot triple (the prototype's `C[tone]` = [soft, ink, dot]). */
export interface Tone {
  soft: string;
  ink: string;
  dot: string;
}

export type ToneName = 'blue' | 'green' | 'amber' | 'red' | 'grey' | 'violet' | 'teal' | 'ink';

/** Tone palette `C` (SPEC §6.1). */
export const tones: Record<ToneName, Tone> = {
  blue: { soft: '#E7EEFB', ink: '#1F3FAF', dot: '#4870E8' },
  green: { soft: '#DFF1EA', ink: '#195040', dot: '#3F9079' },
  amber: { soft: '#FBF1D6', ink: '#7A5C0E', dot: '#E2B23C' },
  red: { soft: '#FBE7E3', ink: '#A5302B', dot: '#D9534F' },
  grey: { soft: '#EEF3FB', ink: '#22354C', dot: '#A9B6C5' },
  violet: { soft: '#EEE9FB', ink: '#5B3FB8', dot: '#7C5CD6' },
  teal: { soft: '#DFF1F0', ink: '#1F6F6E', dot: '#3E908F' },
  ink: { soft: '#1B2D45', ink: '#FFFFFF', dot: '#FFFFFF' },
};

/** Company tile palette `LGC`, picked by a hash of the company name. */
export const tilePalette = ['#4870E8', '#9F89E5', '#B98A2F', '#3F9079', '#D2724A', '#3E908F'] as const;

/** Heat table cell colour for a share 0–1 of the week's maximum (rgba(72,112,232,.18–.90)). */
export function heatColor(share: number): string {
  const a = 0.18 + Math.max(0, Math.min(1, share)) * 0.72;
  return `rgba(72,112,232,${a.toFixed(2)})`;
}
