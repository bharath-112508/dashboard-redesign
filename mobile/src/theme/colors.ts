/**
 * Colour tokens (SPEC.md §5.1). Feature code imports these; no raw hex in screens.
 */
export const colors = {
  ink: '#1B2D45',
  ink2: '#22354C',
  ink3: '#3B4A5E',
  inkBody: '#33445A',
  muted: '#6A7A8E',
  faint: '#A9B6C5',
  bg: '#F6F9FC',
  surface: '#FFFFFF',
  device: '#0E1622',
  overlay: 'rgba(14,22,34,0.42)',

  line: '#D6DEE8',
  lineInput: '#C9D2DD',
  lineHeader: '#E4EAF0',
  lineTabbar: '#E1E7EF',
  divider: '#F1F4F8',
  divider2: '#EEF2F6',
  track: '#EEF3FB',

  primary: '#4870E8',
  primaryInk: '#1F3FAF',
  primarySoft: '#E7EEFB',
  primarySoft2: '#DCE5FA',
  brand: '#3A63E0',
  unreadBg: '#F7FAFF',
  sprintActiveBg: '#F6F9FF',
  boardCol: '#EDF2F8',
  stepper: '#F3F6FA',

  danger: '#C0392B',
  dangerInk: '#8E2A1F',
  dangerSoft: '#FBE7E3',
  dangerRing: '#F0C9B8',
  destructiveBg: '#FBF3EF',
  destructiveInk: '#A5502C',

  orange: '#D2724A',
  orangeSoft: '#F6DDD0',
  orangeInk: '#7A3818',
  amber: '#B98A2F',
  amberSoft: '#FBEDC2',
  amberInk: '#7A5C0E',
  nonBillable: '#D9A93E',
  idle: '#E86A5A',
  green: '#3F9079',
  greenSoft: '#D6E9E2',
  greenInk: '#195040',
  greenLive: '#2F7F68',
  mint: '#7FD1B4',
  teal: '#3E908F',
  tealSoft: '#DFF1F0',
  tealInk: '#1F6F6E',
  tealDark: '#163B3A',
  tealOnDark: '#BFDCD9',
  violet: '#9F89E5',
  violetSoft: '#E6DFFA',
  violetInk: '#3F2E94',
  teamLogged: '#A9C0F2',
  clientAvatar: '#56657A',
  white: '#FFFFFF',
  transparent: 'transparent',
} as const;

export type ColorToken = keyof typeof colors;

/** A dot / soft / ink triple used by status-like pills. */
export interface Tone {
  dot: string;
  soft: string;
  ink: string;
}

/** Soft background for an accent colour (prototype SOFT map). */
export const softOf: Record<string, string> = {
  [colors.primary]: colors.primarySoft,
  [colors.danger]: colors.dangerSoft,
  [colors.orange]: colors.orangeSoft,
  [colors.green]: colors.greenSoft,
  [colors.violet]: colors.violetSoft,
  [colors.amber]: colors.amberSoft,
};

/** Epic palette, cycled by epic index: [colour, soft, ink]. */
export const epicPalette: readonly Tone[] = [
  { dot: '#4870E8', soft: '#DCE5FA', ink: '#1F3FAF' },
  { dot: '#9F89E5', soft: '#E6DFFA', ink: '#3F2E94' },
  { dot: '#3E908F', soft: '#DFF1F0', ink: '#1F6F6E' },
  { dot: '#B98A2F', soft: '#FBEDC2', ink: '#7A5C0E' },
  { dot: '#3F9079', soft: '#D6E9E2', ink: '#195040' },
];
