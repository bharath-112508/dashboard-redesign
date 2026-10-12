import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { PrimaryButton } from '@/components/Buttons';
import { Card } from '@/components/Card';
import { BrandMark } from '@/components/CompanyLogo';
import { Field, FieldError } from '@/components/fields/Field';
import { TextField } from '@/components/fields/TextField';
import { Icon } from '@/components/Icon';
import { Txt } from '@/components/Txt';
import { DEMO_PASSWORD } from '@/data/seed/people';
import { sampleAccounts } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { colors, motion, space, useLoop } from '@/theme';

/**
 * S-LOGIN Sign in (M-01, M-02). Email + password (demo password "demo", prefilled);
 * or tap a sample account. Errors use the web app's copy (DECISIONS.md 5).
 */
export function SignInScreen() {
  const draft = useAppState((s) => s.session.email);
  const accounts = useAppState(sampleAccounts);
  const { signIn, signInAs, setEmailDraft } = useActions();
  const [password, setPassword] = useState(DEMO_PASSWORD);
  const [error, setError] = useState<{ field: 'email' | 'password'; message: string } | null>(null);
  const stamp = useLoop(motion.stamp());

  const enter = () => router.replace('/home');

  const submit = () => {
    const r = signIn(draft, password);
    if (r.ok) enter();
    else setError({ field: r.field, message: r.message });
  };

  return (
    <SafeAreaView style={styles.root} testID="screen-sign-in">
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Animated.View style={stamp}>
              <BrandMark size={40} radius={12} />
            </Animated.View>
            <Txt v="titleSm" w={800}>
              Viljetech
            </Txt>
          </View>

          <View style={styles.titles}>
            <Txt v="display" accessibilityRole="header">
              Sign in
            </Txt>
            <Txt v="bodyLg" color={colors.ink2}>
              Use your work email to continue.
            </Txt>
          </View>

          <View style={styles.form}>
            <Field label="Email">
              <TextField
                label="Email"
                value={draft}
                onChangeText={(t) => {
                  setEmailDraft(t);
                  setError(null);
                }}
                placeholder="you@company.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                textContentType="emailAddress"
                returnKeyType="next"
                onSubmitEditing={submit}
                highlight={error?.field === 'email'}
                testID="sign-in-email"
              />
            </Field>
            <Field label="Password">
              <TextField
                label="Password"
                value={password}
                onChangeText={(t) => {
                  setPassword(t);
                  setError(null);
                }}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="password"
                textContentType="password"
                returnKeyType="go"
                onSubmitEditing={submit}
                highlight={error?.field === 'password'}
                testID="sign-in-password"
              />
            </Field>
            <FieldError text={error?.message ?? ''} />
            <PrimaryButton label="Sign in" onPress={submit} testID="sign-in-submit" />
          </View>

          <View style={styles.divider} accessibilityRole="header">
            <View style={styles.line} />
            <Txt v="eyebrow" color={colors.ink2} style={styles.dividerText}>
              Sample accounts
            </Txt>
            <View style={styles.line} />
          </View>

          <View style={styles.accounts}>
            {accounts.map((a, i) => (
              <Animated.View key={a.name} style={motion.fadeUp(i, 0.2, 0.05)}>
                <Card
                  onPress={() => {
                    signInAs(a.name);
                    enter();
                  }}
                  label={`Sign in as ${a.name}, ${a.title}`}
                  pad={12}
                  style={styles.account}
                  testID={`account-${a.role}`}
                >
                  <Avatar name={a.name} size={40} radius={11} initialsOnly={a.client} bg={a.client ? colors.ink : undefined} />
                  <View style={styles.accountText}>
                    <Txt v="rowTitle">{a.name}</Txt>
                    <Txt v="caption" color={colors.ink3} numberOfLines={1}>
                      {a.title}
                    </Txt>
                  </View>
                  <Icon name="chevron-right" size={18} color={colors.muted} />
                </Card>
              </Animated.View>
            ))}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: space.loginGutter, paddingTop: 20, paddingBottom: 40, gap: 26 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  titles: { gap: 6, marginTop: 8 },
  form: { gap: 14 },
  divider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  line: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { letterSpacing: 0.06 * 12 },
  accounts: { gap: 8, marginTop: -12 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  accountText: { flex: 1, gap: 1 },
});
