import { useEffect, useState, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { colors, motion, shadows } from '@/theme';

import { Icon } from './Icon';
import { Txt } from './Txt';

/** How long a toast stays (SPEC §1.5). */
export const TOAST_MS = 2200;

let current: { id: number; text: string } | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Show a toast from anywhere (after a mutation). Replaces the one on screen. */
export function showToast(text: string): void {
  if (!text) return;
  current = { id: ++seq, text };
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, TOAST_MS);
}

/** `const toast = useToast(); toast('Request approved')` */
export function useToast(): (text: string) => void {
  return showToast;
}

/** Mounted once in the root layout; renders the current toast above everything. */
export function ToastHost() {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => current,
  );
  // Keep the last text while it fades out of the accessibility tree.
  const [shown, setShown] = useState(t);
  useEffect(() => setShown(t), [t]);
  if (!shown) return null;
  return (
    <View pointerEvents="none" style={styles.layer}>
      <Animated.View
        key={shown.id}
        style={[styles.toast, motion.fadeIn()]}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        testID="toast"
      >
        <Animated.View style={motion.pop()}>
          <Icon name="circle-check" size={18} color={colors.mint} strokeWidth={2.4} />
        </Animated.View>
        <Txt v="body" w={600} color={colors.white} style={styles.text}>
          {shown.text}
        </Txt>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', left: 0, right: 0, bottom: 104, alignItems: 'center', zIndex: 30, elevation: 30 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: 360,
    marginHorizontal: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 999,
    backgroundColor: colors.ink,
    ...shadows.toast,
  },
  text: { flexShrink: 1 },
});
