import { Platform, type TextStyle } from 'react-native';

/**
 * Inter, one family name per weight (custom fonts ignore fontWeight on Android, so the
 * weight is chosen through fontFamily). Loaded in src/app/_layout.tsx.
 */
export const fontFamily = {
  400: 'Inter_400Regular',
  500: 'Inter_500Medium',
  600: 'Inter_600SemiBold',
  700: 'Inter_700Bold',
  800: 'Inter_800ExtraBold',
} as const;

/** Monospace for ticket keys and versions (`ui-monospace, Menlo, monospace`). */
export const monoFamily = Platform.select({ ios: 'Menlo', default: 'monospace' }) as string;

export type FontWeight = keyof typeof fontFamily;

/** Style for a weight. */
export function font(weight: FontWeight): TextStyle {
  return { fontFamily: fontFamily[weight] };
}

interface TypeStyle {
  size: number;
  weight: FontWeight;
  /** letter-spacing in em (converted to px below) */
  tracking?: number;
  lineHeight?: number;
  upper?: boolean;
  mono?: boolean;
}

/** Type scale (SPEC §6.1). */
export const typeScale = {
  /** root screen title 26/800 */
  titleRoot: { size: 26, weight: 800, tracking: -0.02, lineHeight: 1.15 },
  /** KPI value 21/800 */
  kpi: { size: 21, weight: 800, tracking: -0.02 },
  /** hero title 20/800 */
  hero: { size: 20, weight: 800, tracking: -0.015, lineHeight: 1.2 },
  /** pushed screen title, sheet title 19/800 */
  title: { size: 19, weight: 800, tracking: -0.01, lineHeight: 1.2 },
  /** section head 15/800 */
  section: { size: 15, weight: 800, tracking: -0.01 },
  /** inputs 15 */
  input: { size: 15, weight: 400 },
  /** row title 14.5/600 */
  rowTitle: { size: 14.5, weight: 600 },
  /** body 14 */
  body: { size: 14, weight: 400, lineHeight: 1.5 },
  /** list items, progress titles 13.5/600 */
  item: { size: 13.5, weight: 600 },
  /** chips, segments 13 */
  label: { size: 13, weight: 600 },
  /** sub lines 12.5 */
  sub: { size: 12.5, weight: 400 },
  /** meta 12 */
  meta: { size: 12, weight: 500 },
  /** badges, KPI sub 11.5 */
  small: { size: 11.5, weight: 600 },
  /** eyebrow 11/800 uppercase .06em */
  eyebrow: { size: 11, weight: 800, tracking: 0.06, upper: true },
  /** tab label 11 */
  tab: { size: 11, weight: 600 },
  /** tiny counts 10.5 */
  tiny: { size: 10.5, weight: 700 },
  /** mono key 11.5/700 */
  key: { size: 11.5, weight: 700, mono: true },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof typeScale;

/** Resolve a type variant to a React Native text style. */
export function typeStyle(variant: TypeVariant, weight?: FontWeight): TextStyle {
  const t: TypeStyle = typeScale[variant];
  const style: TextStyle = t.mono
    ? { fontFamily: monoFamily, fontWeight: String(weight ?? t.weight) as TextStyle['fontWeight'], fontSize: t.size }
    : { ...font(weight ?? t.weight), fontSize: t.size, fontVariant: ['tabular-nums'] };
  if (t.tracking) style.letterSpacing = t.tracking * t.size;
  if (t.lineHeight) style.lineHeight = Math.round(t.lineHeight * t.size);
  if (t.upper) style.textTransform = 'uppercase';
  return style;
}
