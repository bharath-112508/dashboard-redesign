import {
  SchibstedGrotesk_400Regular,
  SchibstedGrotesk_500Medium,
  SchibstedGrotesk_600SemiBold,
  SchibstedGrotesk_700Bold,
  SchibstedGrotesk_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/schibsted-grotesk';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ToastHost } from '@/components/Toast';
import { me } from '@/data/selectors';
import { store, useAppState, useHydrated } from '@/data/store';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Root: fonts, persisted store hydration, safe area, gesture handler, toast host.
 * Auth: (app) is only reachable when signed in; sign-in only when signed out. When the
 * session changes, expo-router moves to the first screen that is allowed.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SchibstedGrotesk_400Regular,
    SchibstedGrotesk_500Medium,
    SchibstedGrotesk_600SemiBold,
    SchibstedGrotesk_700Bold,
    SchibstedGrotesk_800ExtraBold,
  });
  const hydrated = useHydrated();
  const signedIn = useAppState((s) => !!me(s)?.role);
  const ready = (fontsLoaded || !!fontError) && hydrated;

  useEffect(() => {
    store.hydrate();
  }, []);

  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);

  if (!ready) return <View style={styles.root} />;

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
          <Stack.Protected guard={!signedIn}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
          <Stack.Protected guard={signedIn}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Screen name="index" />
          <Stack.Screen name="dev/kitchen-sink" options={{ headerShown: true, title: 'Kitchen sink' }} />
        </Stack>
        <ToastHost />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
