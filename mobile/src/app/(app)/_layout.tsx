import { Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { TabBar } from '@/components/TabBar';
import { colors } from '@/theme';

/** Deep links land on a pushed screen with the tabs underneath. */
export const unstable_settings = { initialRouteName: '(tabs)' };

const SHEETS = ['sheet/log-time', 'sheet/report', 'sheet/leave', 'sheet/project-status', 'sheet/support-plan'];

/**
 * Signed-in shell: one stack per session (SPEC §1.2). The tab roots live in (tabs);
 * every other screen is pushed on top. The floating TabBar is drawn once, here, and
 * highlights the tab that owns the stack. Sheets are transparent modal routes.
 */
export default function AppLayout() {
  return (
    <View style={styles.root}>
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="(tabs)" />
        {SHEETS.map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{
              presentation: 'transparentModal',
              animation: 'none',
              contentStyle: { backgroundColor: 'transparent' },
            }}
          />
        ))}
      </Stack>
      <TabBar />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
