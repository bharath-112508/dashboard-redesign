import { cubicBezier, type CSSAnimationFillMode, type CSSAnimationKeyframes } from 'react-native-reanimated';

/**
 * Animation presets (SPEC.md §5.6) as Reanimated 4 CSS animations. Spread one into the
 * style of an `Animated.View` / `Animated.Text`:
 *
 *   <Animated.View style={[styles.card, motion.fadeUp(i)]} />
 *
 * Looping presets (bell, bob, twinkle, drift, critDot) must be switched off when the
 * user prefers reduced motion; use `useLoop()` from '@/theme/useMotion' or the
 * `Animated*` wrappers in src/components/motion.tsx, which already do that.
 */

/**
 * Reanimated accepts cubicBezier() objects at runtime; the Animated style typings only
 * list strings, so the objects are typed as timing strings here.
 */
type Timing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';
export const easing = {
  out: cubicBezier(0.2, 0.8, 0.2, 1) as unknown as Timing,
  sheet: cubicBezier(0.16, 1, 0.3, 1) as unknown as Timing,
} as const;

/** One CSS animation for an Animated.View style (a narrowed CSSAnimationProperties). */
export interface Anim {
  animationName: CSSAnimationKeyframes;
  animationDuration?: `${number}ms`;
  animationDelay?: `${number}ms`;
  animationTimingFunction?: Timing;
  animationIterationCount?: number | 'infinite';
  animationFillMode?: CSSAnimationFillMode;
}

const fadeUpKeys = {
  from: { opacity: 0, transform: [{ translateY: 10 }] },
  to: { opacity: 1, transform: [{ translateY: 0 }] },
};

const popKeys = {
  0: { opacity: 0, transform: [{ scale: 0.5 }] },
  0.6: { opacity: 1, transform: [{ scale: 1.15 }] },
  1: { opacity: 1, transform: [{ scale: 1 }] },
};

const stampKeys = {
  0: { opacity: 0, transform: [{ scale: 1.5 }] },
  0.6: { opacity: 1, transform: [{ scale: 0.94 }] },
  1: { opacity: 1, transform: [{ scale: 1 }] },
};

const bellKeys = {
  0: { transform: [{ rotate: '0deg' }] },
  0.15: { transform: [{ rotate: '16deg' }] },
  0.3: { transform: [{ rotate: '-13deg' }] },
  0.45: { transform: [{ rotate: '9deg' }] },
  0.6: { transform: [{ rotate: '-5deg' }] },
  0.75: { transform: [{ rotate: '2deg' }] },
  1: { transform: [{ rotate: '0deg' }] },
};

const bobKeys = {
  0: { transform: [{ translateY: 0 }] },
  0.5: { transform: [{ translateY: -3 }] },
  1: { transform: [{ translateY: 0 }] },
};

const twinkleKeys = {
  0: { transform: [{ scale: 1 }, { rotate: '0deg' }] },
  0.5: { transform: [{ scale: 1.12 }, { rotate: '12deg' }] },
  1: { transform: [{ scale: 1 }, { rotate: '0deg' }] },
};

const driftKeys = {
  0: { transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '0deg' }] },
  0.5: { transform: [{ translateX: 2.5 }, { translateY: -2.5 }, { rotate: '-4deg' }] },
  1: { transform: [{ translateX: 0 }, { translateY: 0 }, { rotate: '0deg' }] },
};

const critDotKeys = { 0: { opacity: 1 }, 0.5: { opacity: 0.25 }, 1: { opacity: 1 } };

const fadeInKeys = { from: { opacity: 0 }, to: { opacity: 1 } };

const sheetUpKeys = {
  from: { transform: [{ translateY: 600 }] },
  to: { transform: [{ translateY: 0 }] },
};

const ms = (s: number) => `${Math.round(s * 1000)}ms` as const;

export const motion = {
  /** Screen enter (.35s). */
  screenIn: (): Anim => ({
    animationName: fadeUpKeys,
    animationDuration: '350ms',
    animationTimingFunction: easing.out,
    animationFillMode: 'both',
  }),
  /** List item enter with stagger: delay = base + i * step (seconds). */
  fadeUp: (i = 0, base = 0.05, step = 0.06, duration = 0.4): Anim => ({
    animationName: fadeUpKeys,
    animationDuration: ms(duration),
    animationDelay: ms(base + i * step),
    animationTimingFunction: easing.out,
    animationFillMode: 'both',
  }),
  pop: (duration = 0.45): Anim => ({
    animationName: popKeys,
    animationDuration: ms(duration),
    animationTimingFunction: easing.out,
    animationFillMode: 'both',
  }),
  stamp: (): Anim => ({
    animationName: stampKeys,
    animationDuration: '600ms',
    animationTimingFunction: easing.out,
    animationFillMode: 'both',
  }),
  fadeIn: (duration = 0.2): Anim => ({
    animationName: fadeInKeys,
    animationDuration: ms(duration),
    animationFillMode: 'both',
  }),
  sheetUp: (): Anim => ({
    animationName: sheetUpKeys,
    animationDuration: '280ms',
    animationTimingFunction: easing.sheet,
    animationFillMode: 'both',
  }),
  // Looping presets: gate with reduced motion.
  bell: (duration = 1.3, count: number | 'infinite' = 2, delay = 0.5): Anim => ({
    animationName: bellKeys,
    animationDuration: ms(duration),
    animationDelay: ms(delay),
    animationIterationCount: count,
    animationTimingFunction: 'ease-in-out',
  }),
  bob: (): Anim => ({
    animationName: bobKeys,
    animationDuration: '2400ms',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  }),
  twinkle: (): Anim => ({
    animationName: twinkleKeys,
    animationDuration: '2200ms',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  }),
  drift: (): Anim => ({
    animationName: driftKeys,
    animationDuration: '3000ms',
    animationIterationCount: 'infinite',
    animationTimingFunction: 'ease-in-out',
  }),
  critDot: (): Anim => ({
    animationName: critDotKeys,
    animationDuration: '1000ms',
    animationIterationCount: 'infinite',
  }),
} as const;

/** Press-scale amounts (SPEC.md §5.6 micro-interactions). */
export const pressScale = { card: 0.98, tile: 0.97, tab: 0.94 } as const;
