import { Platform, type ViewStyle } from 'react-native';

/** Spacing (SPEC §1.1, §1.5, §6.2). */
export const space = {
  gutter: 16,
  /** gap between blocks on a screen */
  block: 18,
  /** gap between blocks in a sheet */
  sheetBlock: 16,
  /** gap between a section head and its block */
  head: 8,
  /** form fields */
  field: 12,
  /** content bottom padding with / without the tab bar */
  bottomTabs: 110,
  bottomPlain: 40,
} as const;

/** Control heights (SPEC §6.2). */
export const control = {
  button: 48,
  input: 48,
  search: 44,
  segment: 36,
  chip: 34,
  pick: 36,
  headerButton: 40,
  sectionAction: 30,
  heroBadge: 32,
  heroChip: 26,
  badge: 22,
  send: 46,
} as const;

/** Radii (SPEC §6.1). */
export const radii = {
  sheet: 28,
  tabBar: 24,
  hero: 20,
  card: 16,
  button: 14,
  heroTile: 13,
  input: 12,
  sheetClose: 11,
  tile: 10,
  segment: 9,
  chip: 8,
  badge: 7,
  pill: 999,
} as const;

/** Floating tab bar: height, bottom offset, side inset. */
export const tabBar = { height: 66, bottom: 22, side: 12 } as const;

function shadow(css: string, native: { y: number; blur: number; opacity: number; elevation: number }): ViewStyle {
  if (Platform.OS === 'web') return { boxShadow: css } as ViewStyle;
  return {
    shadowColor: '#1B2D45',
    shadowOffset: { width: 0, height: native.y },
    shadowOpacity: native.opacity,
    shadowRadius: native.blur / 2,
    elevation: native.elevation,
  };
}

/** Shadows (SPEC §6.1). Rings are 1px borders, see `ring`. */
export const shadows = {
  segmentActive: shadow('0 1px 3px rgba(27,45,69,0.15)', { y: 1, blur: 3, opacity: 0.15, elevation: 1 }),
  boardCard: shadow('0 1px 2px rgba(27,45,69,0.08)', { y: 1, blur: 2, opacity: 0.08, elevation: 1 }),
  tabBar: shadow('0 12px 32px -10px rgba(27,45,69,0.3), 0 0 0 1px #E4EAF0', { y: 12, blur: 32, opacity: 0.18, elevation: 8 }),
  sheet: shadow('0 -10px 40px rgba(14,22,34,0.25)', { y: -10, blur: 40, opacity: 0.25, elevation: 16 }),
  knob: shadow('0 1px 2px rgba(0,0,0,0.2)', { y: 1, blur: 2, opacity: 0.2, elevation: 2 }),
} as const;

/** 1px ring in a colour (the prototype's `0 0 0 1px` box-shadow). */
export function ring(color: string): ViewStyle {
  return { borderWidth: 1, borderColor: color };
}
