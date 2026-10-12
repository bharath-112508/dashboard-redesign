import { useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { colors, motion } from '@/theme';

import { Icon } from './Icon';
import { Txt } from './Txt';

/** How long a toast stays (SPEC §1.6). */
export const TOAST_MS = 2400;

let current: { id: number; text: string } | null = null;
let seq = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Show a toast from anywhere (after a command). A newer toast replaces the current one. */
export function showToast(text: string | null | undefined): void {
  if (!text) return;
  current = { id: ++seq, text };
  emit();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, TOAST_MS);
}

/** Show a command result: the toast on success, the error otherwise. Returns ok. */
export function toastResult(r: { ok: true; toast: string } | { ok: false; error: string }): boolean {
  showToast(r.ok ? r.toast : r.error);
  return r.ok;
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
  if (!t) return null;
  return (
    <View pointerEvents="none" style={styles.layer}>
      <Animated.View key={t.id} style={[styles.toast, motion.fadeIn(150)]} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="toast">
        <Icon name="circle-check" size={18} color={colors.toastIcon} />
        <Txt v="item" color={colors.white} style={styles.text}>
          {t.text}
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
    maxWidth: '86%',
    paddingVertical: 11,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: colors.ink,
  },
  text: { flexShrink: 1 },
});
