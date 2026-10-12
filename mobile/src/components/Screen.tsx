import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute } from 'expo-router';
import { useNavigationState } from 'expo-router/react-navigation';

import { colors, motion, space, TAB_BAR_SPACE, useLoop } from '@/theme';

import { LargeHeader, SmallHeader, type HeaderAction } from './Headers';

export interface ScreenProps {
  title: string;
  /** large on tab roots, small on pushed screens */
  header?: 'large' | 'small';
  action?: HeaderAction;
  /** fixed bar at the bottom (Composer on ticket / question) */
  footer?: ReactNode;
  /** true when the tab bar is hidden on this screen (ticket, question) */
  noTabBar?: boolean;
  /** false to render children without the ScrollView (own FlatList) */
  scroll?: boolean;
  /** gap between direct children (default 14) */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
  /** test id of the screen root, e.g. "screen-home" */
  testID?: string;
  children: ReactNode;
}

/**
 * Screen scaffold: safe area, header, scrolling content (padding 4/16/28 plus room for
 * the floating tab bar) with the tc-fade-up enter animation, and an optional footer.
 */
export function Screen({
  title,
  header = 'small',
  action,
  footer,
  noTabBar,
  scroll = true,
  gap = space.gap.detail,
  contentStyle,
  testID,
  children,
}: ScreenProps) {
  const enter = useLoop(motion.screenIn());
  const hidden = useHiddenTab();
  const bottom = (noTabBar || footer ? 0 : TAB_BAR_SPACE) + space.contentBottom;
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.content, { gap, paddingBottom: bottom }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  );
  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.root, hidden && styles.hidden]}
      testID={testID}
      aria-hidden={hidden || undefined}
    >
      {header === 'large' ? <LargeHeader title={title} action={action} /> : <SmallHeader title={title} action={action} />}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Animated.View style={[styles.flex, enter]}>{body}</Animated.View>
        {footer}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Tab roots stay mounted when another tab is selected (web keeps them in the DOM behind
 * the selected one). Hide them so taps, tests and screen readers only reach the
 * selected tab. Stack screens under a sheet stay visible.
 */
function useHiddenTab(): boolean {
  const route = useRoute();
  return useNavigationState((s) => !!s && s.type === 'tab' && s.routes[s.index]?.key !== route.key);
}

const styles = StyleSheet.create({
  hidden: { display: 'none' },
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  content: { paddingTop: 4, paddingHorizontal: space.gutter },
});
