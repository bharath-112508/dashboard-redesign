import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { closeSheet } from '@/nav/routes';
import { useRouteAllowed } from '@/nav/useRouteAllowed';
import { colors, motion, radii, shadows, space } from '@/theme';

import { Button, ButtonRow } from './Buttons';
import { Icon } from './Icon';
import { Press } from './Press';
import { TextBlock } from './TextBlock';
import { Txt } from './Txt';

export interface BottomSheetProps {
  title: string;
  sub?: string;
  /** default: pop the sheet route */
  onClose?: () => void;
  children: ReactNode;
  /**
   * Inline mode (component state, no route): pass `visible`. The sheet renders in a
   * transparent Modal. Without `visible` the sheet is a URL sheet route body.
   */
  visible?: boolean;
  /** test id of the panel (default "sheet") */
  testID?: string;
}

/**
 * Bottom sheet (SPEC §1.5, D-CMP-1): backdrop rgba(14,22,34,.42) (tap closes), panel
 * #F6F9FC, radius 28, max 90%, handle 40x5, title 19/800 + sub 13, close 36 r11 #E7ECF2,
 * body padding 2/18/34 with blocks 16 apart, sheetUp .26s.
 *
 * URL sheet: render it as the whole body of `src/app/(app)/sheet/<name>.tsx`.
 * Inline sheet: `<BottomSheet visible={open} onClose={() => setOpen(false)} …>`.
 */
export function BottomSheet({ title, sub, onClose, children, visible, testID = 'sheet' }: BottomSheetProps) {
  const inline = visible !== undefined;
  const close = onClose ?? closeSheet;
  const insets = useSafeAreaInsets();
  const allowed = useRouteAllowed();
  if (!inline && !allowed) return null;
  const body = (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, motion.fadeIn(180)]}>
        <Pressable style={styles.backdrop} onPress={close} accessibilityRole="button" accessibilityLabel="Close sheet" testID={`${testID}-backdrop`} />
      </Animated.View>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.kav} pointerEvents="box-none">
        <Animated.View style={[styles.panel, motion.sheetUp()]} accessibilityViewIsModal testID={testID}>
          <View style={styles.handle} />
          <View style={styles.head}>
            <View style={styles.headText}>
              <Txt v="title" accessibilityRole="header" numberOfLines={2}>
                {title}
              </Txt>
              {sub ? (
                <Txt v="label" w={400} color={colors.ink3} numberOfLines={2} style={styles.sub}>
                  {sub}
                </Txt>
              ) : null}
            </View>
            <Press label="Close" onPress={close} style={styles.close} testID={`${testID}-close`}>
              <Icon name="x" size={17} color={colors.ink} />
            </Press>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 34 }]} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
  if (!inline) return body;
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close} statusBarTranslucent>
      {body}
    </Modal>
  );
}

export interface ConfirmSheetProps {
  visible: boolean;
  title: string;
  /** note text (amber note block) */
  text: string;
  /** destructive button title ("Delete", "Remove", "Archive") */
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  testID?: string;
}

/** SH-CONFIRM: title, a note, Cancel (secondary) and a destructive OK. Inline. */
export function ConfirmSheet({ visible, title, text, confirm, onConfirm, onClose, testID = 'confirm' }: ConfirmSheetProps) {
  return (
    <BottomSheet visible={visible} title={title} onClose={onClose} testID={testID}>
      <TextBlock text={text} tone="note" />
      <ButtonRow>
        <Button title="Cancel" kind="s" onPress={onClose} testID={`${testID}-cancel`} />
        <Button
          title={confirm}
          kind="d"
          onPress={() => {
            onClose();
            onConfirm();
          }}
          testID={`${testID}-ok`}
        />
      </ButtonRow>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  kav: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    maxHeight: '90%',
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: 'hidden',
    ...shadows.sheet,
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.handle, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, paddingHorizontal: 18 },
  headText: { flex: 1, minWidth: 0 },
  sub: { marginTop: 2 },
  close: { width: 36, height: 36, borderRadius: radii.sheetClose, backgroundColor: colors.segTrack, alignItems: 'center', justifyContent: 'center' },
  scroll: { flexGrow: 0 },
  body: { paddingTop: 2, paddingHorizontal: 18, gap: space.sheetBlock },
});
