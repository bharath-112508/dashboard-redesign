import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRoute } from 'expo-router';
import { useNavigationState } from 'expo-router/react-navigation';

import { useRouteAllowed } from '@/nav/useRouteAllowed';
import { colors, space } from '@/theme';

import { AccessDenied } from './AccessDenied';
import { Header, type HeaderAction } from './Header';

export interface ScreenProps {
  title: string;
  sub?: string;
  /** up to 3 header buttons; tab roots usually pass `useRootActions()` */
  actions?: HeaderAction[];
  /** force root (26px title, no Back) or pushed; default: root when the screen is a tab */
  root?: boolean;
  /** Sign in: no header and no tab bar padding */
  noHeader?: boolean;
  /** false: no tab bar below (bottom padding 40 instead of 110) */
  tabBar?: boolean;
  /** false to render children without the ScrollView (own list) */
  scroll?: boolean;
  /** gap between blocks (default 18) */
  gap?: number;
  contentStyle?: StyleProp<ViewStyle>;
  /** test id of the screen root, e.g. "screen-home" */
  testID?: string;
  children: ReactNode;
}

/**
 * Screen scaffold (SPEC §1.1): safe area, v5 header, a vertical scroll with padding 4/16
 * and 18 between blocks, bottom padding 110 (tab bar) or 40. Renders an access-denied
 * state when the route is not allowed for the role (the RouteGuard then sends the
 * person Home with a toast).
 */
export function Screen({ title, sub, actions, root, noHeader, tabBar = true, scroll = true, gap = space.block, contentStyle, testID, children }: ScreenProps) {
  const hidden = useHiddenTab();
  const isTab = useNavigationState((s) => !!s && s.type === 'tab');
  const allowed = useRouteAllowed();
  const isRoot = root ?? isTab;
  const bottom = tabBar && !noHeader ? space.bottomTabs : space.bottomPlain;
  const content = allowed ? children : <AccessDenied />;
  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.content, { gap, paddingBottom: bottom }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {content}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{content}</View>
  );
  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, hidden && styles.hidden]} testID={testID} aria-hidden={hidden || undefined}>
      {noHeader ? null : <Header title={title} sub={sub} actions={allowed ? actions : []} root={isRoot} />}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * Tab roots stay mounted when another tab is selected (web keeps them in the DOM behind
 * the selected one). Hide them so taps, tests and screen readers only reach the
 * selected tab.
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
