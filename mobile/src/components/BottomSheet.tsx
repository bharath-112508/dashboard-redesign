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
  /**
   * form (default): 40px icon tile (radius 14), 20/800 title, subtitle under the header row,
   * no dividers. plan (support plan): 36px circular icon, 18/800 title with the subtitle
   * under it, dividers under the header and above the footer.
   */
  variant?: 'form' | 'plan';
  /** title size: md 20 (default for form), sm 18 (plan, project status) */
  titleSize?: 'md' | 'sm';
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
  variant = 'form',
  titleSize,
  children,
  testID = 'sheet',
}: BottomSheetProps) {
  const plan = variant === 'plan';
  const titleV = (titleSize ?? (plan ? 'sm' : 'md')) === 'sm' ? 'sheetTitle' : 'titleMd';
  const sub = subtitle ? (
    <Txt v={plan ? 'meta' : 'bodySm'} w={400} color={colors.ink3} numberOfLines={2} style={plan ? null : styles.subBelow}>
      {subtitle}
    </Txt>
  ) : null;
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
          <View style={[styles.headWrap, plan && styles.headPlan]}>
            <View style={[styles.head, plan && { gap: 10 }]}>
              {icon ? (
                <Animated.View style={plan ? null : drift}>
                  {plan ? (
                    <IconTile icon={icon} bg={iconBg} fg={iconFg} size={36} radius={18} iconSize={18} />
                  ) : (
                    <IconTile icon={icon} bg={iconBg} fg={iconFg} size={40} radius={14} iconSize={19} />
                  )}
                </Animated.View>
              ) : null}
              <View style={styles.headText}>
                <Txt v={titleV} accessibilityRole="header" numberOfLines={2}>
                  {title}
                </Txt>
                {plan ? sub : null}
              </View>
              {showClose ? (
                <Press label="Close" onPress={onClose} style={styles.close} scale={0.94} testID="sheet-close">
                  <Icon name="x" size={16} color={colors.destructiveInk} strokeWidth={2.6} />
                </Press>
              ) : null}
            </View>
            {plan ? null : sub}
          </View>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={[styles.body, plan && styles.bodyPlan, !footer && { paddingBottom: insets.bottom + 34 }]}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>
          {footer ? (
            <View style={[styles.footer, plan && styles.footerPlan, { paddingBottom: insets.bottom + (plan ? 30 : 34) }]}>{footer}</View>
          ) : null}
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
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.lineInput, marginTop: 10 },
  headWrap: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12 },
  headPlan: { paddingTop: 6, borderBottomWidth: 1, borderBottomColor: colors.divider2 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headText: { flex: 1, gap: 1 },
  subBelow: { marginTop: 6 },
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
  bodyPlan: { paddingTop: 14, paddingBottom: 14 },
  footer: { paddingHorizontal: 20, paddingTop: 16, gap: 12 },
  footerPlan: { paddingTop: 12, gap: 8, borderTopWidth: 1, borderTopColor: colors.divider2 },
});
