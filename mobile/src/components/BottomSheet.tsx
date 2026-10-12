import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type DimensionValue } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { closeSheet } from '@/nav/routes';
import { colors, motion, radii, useLoop } from '@/theme';

import { Icon, type IconName } from './Icon';
import { IconTile } from './IconTile';
import { Press } from './Press';
import { Txt } from './Txt';

export interface BottomSheetProps {
  title: string;
  /** header icon tile (drifts gently, e.g. timer / bug / calendar-plus / wrench) */
  icon?: IconName;
  iconBg?: string;
  iconFg?: string;
  /** line under the title ("Today, Sat 10 Oct · logged as Chary", project name) */
  subtitle?: string;
  /** default: pop the sheet route (M-46) */
  onClose?: () => void;
  /** close button in the header (the support-plan sheet has none) */
  showClose?: boolean;
  /** panel max height, default 88% */
  maxHeight?: DimensionValue;
  /** sticky footer (error + save button) */
  footer?: ReactNode;
  children: ReactNode;
  testID?: string;
}

/**
 * Bottom sheet chrome (SPEC §1.5): dim backdrop (tap to close), white panel with a
 * 28 radius and grab handle, sliding up. Render it as the whole body of a
 * src/app/(app)/sheet/* route (presentation transparentModal).
 */
export function BottomSheet({
  title,
  icon,
  iconBg = colors.primarySoft,
  iconFg = colors.primaryInk,
  subtitle,
  onClose = closeSheet,
  showClose = true,
  maxHeight = '88%',
  footer,
  children,
  testID = 'sheet',
}: BottomSheetProps) {
  const insets = useSafeAreaInsets();
  const reducedUp = useLoop(motion.sheetUp());
  const drift = useLoop(motion.drift());
  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, motion.fadeIn()]}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
          testID="sheet-backdrop"
        />
      </Animated.View>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.kav}
        pointerEvents="box-none"
      >
        <Animated.View
          style={[styles.panel, { maxHeight }, reducedUp]}
          accessibilityViewIsModal
          testID={testID}
        >
          <View style={styles.handle} />
          <View style={styles.head}>
            {icon ? (
              <Animated.View style={drift}>
                <IconTile icon={icon} bg={iconBg} fg={iconFg} size={40} radius={12} iconSize={20} />
              </Animated.View>
            ) : null}
            <View style={styles.headText}>
              <Txt v="titleMd" accessibilityRole="header" numberOfLines={2}>
                {title}
              </Txt>
              {subtitle ? (
                <Txt v="caption" color={colors.ink3} numberOfLines={2}>
                  {subtitle}
                </Txt>
              ) : null}
            </View>
            {showClose ? (
              <Press label="Close" onPress={onClose} style={styles.close} scale={0.94} testID="sheet-close">
                <Icon name="x" size={18} color={colors.destructiveInk} strokeWidth={2.4} />
              </Press>
            ) : null}
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.body, !footer && { paddingBottom: insets.bottom + 34 }]}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>{footer}</View> : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  kav: { flex: 1, justifyContent: 'flex-end' },
  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    overflow: 'hidden',
  },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.lineInput, marginTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12 },
  headText: { flex: 1, gap: 2 },
  close: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: colors.destructiveBg,
    borderWidth: 1,
    borderColor: colors.dangerRing,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: { flexGrow: 0 },
  body: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },
  footer: { paddingHorizontal: 20, paddingTop: 12, gap: 10, borderTopWidth: 1, borderTopColor: colors.divider2 },
});
