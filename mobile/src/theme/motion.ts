import { cubicBezier, type CSSAnimationFillMode, type CSSAnimationKeyframes } from 'react-native-reanimated';

/**
 * Motion (SPEC §6.1). v5 keeps only: sheetUp .26s cubic-bezier(.2,.8,.2,1), fadeIn
 * (.18s backdrop, .15s toast), the toggle knob and the tab pill (.15s). No loops.
 * Spread a preset into an `Animated.View` style.
 */
type Timing = 'linear' | 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out';
export const easing = {
  out: cubicBezier(0.2, 0.8, 0.2, 1) as unknown as Timing,
} as const;

export interface Anim {
  animationName: CSSAnimationKeyframes;
  animationDuration?: `${number}ms`;
  animationTimingFunction?: Timing;
  animationFillMode?: CSSAnimationFillMode;
}

const fadeInKeys = { from: { opacity: 0 }, to: { opacity: 1 } };
const sheetUpKeys = { from: { transform: [{ translateY: 600 }] }, to: { transform: [{ translateY: 0 }] } };

export const motion = {
  fadeIn: (ms = 180): Anim => ({ animationName: fadeInKeys, animationDuration: `${ms}ms`, animationFillMode: 'both' }),
  sheetUp: (): Anim => ({
    animationName: sheetUpKeys,
    animationDuration: '260ms',
    animationTimingFunction: easing.out,
    animationFillMode: 'both',
  }),
} as const;

/** Press feedback: a light opacity dip (v5 has no press scale). */
export const pressOpacity = 0.7;
