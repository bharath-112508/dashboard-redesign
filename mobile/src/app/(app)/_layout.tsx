import { router, Stack, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { TabBar } from '@/components/TabBar';
import { showToast } from '@/components/Toast';
import { useAppState } from '@/data/store';
import { ACCESS_DENIED, myRouteAccess, routeNameOf } from '@/nav/access';
import { href, SHEETS } from '@/nav/routes';
import { colors } from '@/theme';

/** Deep links land on a pushed screen with the tabs underneath. */
export const unstable_settings = { initialRouteName: '(tabs)' };

/**
 * Route guard (DECISIONS 6): every (app) route is checked with `can()`; a role without
 * access goes to its Home with the toast "You don't have access to this page".
 */
function RouteGuard() {
  const segments = useSegments();
  const name = routeNameOf(segments);
  const allowed = useAppState((s) => name == null || myRouteAccess(s, name));
  useEffect(() => {
    if (allowed) return;
    showToast(ACCESS_DENIED);
    const sheet = !!name?.startsWith('sheet/');
    // Navigate on the next tick: on a deep link the navigator may still be applying the
    // initial state, and a dismiss dispatched now would duplicate the tab navigator.
    setTimeout(() => {
      if (sheet && router.canDismiss()) router.dismiss();
      else if (router.canDismiss()) router.dismissTo(href.tab('home'));
      else router.navigate(href.tab('home'));
    }, 0);
  }, [allowed, name]);
  return null;
}

/**
 * Signed-in shell: one stack per session (SPEC §1.2). The tab roots live in (tabs);
 * every other screen is pushed on top. The floating TabBar is drawn once, here, on
 * every signed-in screen; URL sheets are transparent modal routes that cover it.
 */
export default function AppLayout() {
  return (
    <View style={styles.root}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        {SHEETS.map((name) => (
          <Stack.Screen
            key={name}
            name={`sheet/${name}`}
            options={{ presentation: 'transparentModal', animation: 'none', contentStyle: { backgroundColor: 'transparent' } }}
          />
        ))}
      </Stack>
      <TabBar />
      <RouteGuard />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
