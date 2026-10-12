import { Tabs } from 'expo-router/js-tabs';

import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { ALL_TABS, isTabOf } from '@/nav/tabs';
import { colors } from '@/theme';

/**
 * Tab roots. The visible tab bar is the custom TabBar drawn by the (app) layout, so the
 * navigator's own bar is hidden. Tabs the role does not have get `href: null`.
 */
export default function TabsLayout() {
  const role = useAppState((s) => me(s)?.role ?? null);
  return (
    <Tabs
      initialRouteName="home"
      tabBar={() => null}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg }, animation: 'none' }}
    >
      {ALL_TABS.map((key) => (
        <Tabs.Screen key={key} name={key} options={{ href: role && isTabOf(role, key) ? undefined : null }} />
      ))}
    </Tabs>
  );
}
