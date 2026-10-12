import type { TextStyle } from 'react-native';

/**
 * Schibsted Grotesk, one family name per weight (custom fonts ignore fontWeight on
 * Android, so the weight is chosen through fontFamily). Loaded in src/app/_layout.tsx.
 */
export const fontFamily = {
  400: 'SchibstedGrotesk_400Regular',
  500: 'SchibstedGrotesk_500Medium',
  600: 'SchibstedGrotesk_600SemiBold',
  700: 'SchibstedGrotesk_700Bold',
  800: 'SchibstedGrotesk_800ExtraBold',
} as const;

export type FontWeight = keyof typeof fontFamily;

/** Style for a weight (prototype 550 maps to 600, 750 to 700). */
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
}

/** Type scale (SPEC.md §5.2). */
export const typeScale = {
  display: { size: 30, weight: 800, tracking: -0.02 },
  titleLg: { size: 28, weight: 800, tracking: -0.02, lineHeight: 1.1 },
  kpi: { size: 26, weight: 800, tracking: -0.02 },
  titleTicket: { size: 22, weight: 800, tracking: -0.01, lineHeight: 1.25 },
  titleMd: { size: 20, weight: 800 },
  titleCard: { size: 19, weight: 800 },
  sheetTitle: { size: 18, weight: 800 },
  section: { size: 17, weight: 800 },
  titleSm: { size: 16, weight: 700 },
  cardTitle: { size: 15.5, weight: 700, lineHeight: 1.3 },
  rowTitle: { size: 15, weight: 700 },
  bodyLg: { size: 14.5, weight: 400, lineHeight: 1.55 },
  body: { size: 14, weight: 400, lineHeight: 1.45 },
  bodySm: { size: 13.5, weight: 600 },
  meta: { size: 13, weight: 600 },
  caption: { size: 12.5, weight: 400 },
  small: { size: 12, weight: 600 },
  chip: { size: 11.5, weight: 700 },
  eyebrow: { size: 12, weight: 700, tracking: 0.08, upper: true },
  tabLabel: { size: 11, weight: 600, tracking: 0.01 },
  badge: { size: 10.5, weight: 800 },
} as const satisfies Record<string, TypeStyle>;

export type TypeVariant = keyof typeof typeScale;

/** Resolve a type variant to a React Native text style. */
export function typeStyle(variant: TypeVariant, weight?: FontWeight): TextStyle {
  const t: TypeStyle = typeScale[variant];
  const style: TextStyle = {
    ...font(weight ?? t.weight),
    fontSize: t.size,
    fontVariant: ['tabular-nums'],
  };
  if (t.tracking) style.letterSpacing = t.tracking * t.size;
  if (t.lineHeight) style.lineHeight = Math.round(t.lineHeight * t.size);
  if (t.upper) style.textTransform = 'uppercase';
  return style;
}
