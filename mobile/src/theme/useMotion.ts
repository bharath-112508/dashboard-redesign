import { useReducedMotion } from 'react-native-reanimated';

import type { Anim } from './motion';

/**
 * Returns the animation only when the user has not asked for reduced motion.
 * Use for every looping animation (bell, bob, twinkle, drift, critDot) and
 * for decorative entrances.
 */
export function useLoop(anim: Anim | null | undefined | false): Anim | undefined {
  const reduced = useReducedMotion();
  if (reduced || !anim) return undefined;
  return anim;
}

/** True when the system asks for reduced motion. */
export function useReducedMotionPref(): boolean {
  return useReducedMotion();
}
