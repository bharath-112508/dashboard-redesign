import { Platform, type ViewStyle } from 'react-native';

/** Spacing (SPEC.md §5.3). */
export const space = {
  gutter: 16,
  headerGutter: 20,
  loginGutter: 22,
  contentBottom: 28,
  sheetBottom: 34,
  gap: { section: 18, detail: 14, list: 12, kpi: 10, cards: 8, status: 6 },
  card: { pad: 14, hero: 16, compact: 12, rowV: 12, rowH: 14 },
} as const;

/** Control heights (SPEC.md §5.3). */
export const control = {
  cta: 52,
  input: 50,
  secondary: 46,
  composer: 42,
  header: 40,
  status: 38,
  segmented: 36,
  smallPill: 34,
  chip: 30,
} as const;

/** Radii (SPEC.md §5.4). */
export const radii = {
  sheet: 28,
  hero: 24,
  boardCol: 22,
  card: 20,
  viewSwitch: 18,
  compactCard: 16,
  tabPill: 15,
  input: 14,
  iconButton: 12,
  segmentInner: 10,
  avatarSm: 9,
  chip: 8,
  key: 5,
  pill: 999,
} as const;

/** Height the floating tab bar occupies; screens pad their content by this much. */
export const TAB_BAR_SPACE = 96;

function shadow(y: number, blur: number, opacity: number, elevation: number): ViewStyle {
  if (Platform.OS === 'web') {
    return { boxShadow: `0 ${y}px ${blur}px rgba(27,45,69,${opacity})` } as ViewStyle;
  }
  return {
    shadowColor: '#1B2D45',
    shadowOffset: { width: 0, height: y },
    shadowOpacity: opacity,
    shadowRadius: blur / 2,
    elevation,
  };
}

/** Shadows (SPEC.md §5.5). Rings are 1px borders, see `ring`. */
export const shadows = {
  segmentActive: shadow(1, 3, 0.15, 1),
  tabBar: shadow(10, 30, 0.2, 8),
  toast: shadow(10, 24, 0.25, 10),
  knob: shadow(1, 3, 0.25, 2),
} as const;

/** 1px ring in a colour (the prototype's `0 0 0 1px` box-shadow). */
export function ring(color: string): ViewStyle {
  return { borderWidth: 1, borderColor: color };
}
