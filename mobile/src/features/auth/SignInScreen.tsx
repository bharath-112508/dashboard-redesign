import { useState } from 'react';

import { BrandMark, TextTile } from '@/components/Avatar';
import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { Form, TextField } from '@/components/fields';
import { Hero } from '@/components/Hero';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { TextBlock } from '@/components/TextBlock';
import { DEMO_PASSWORD } from '@/data/clock';
import { ROLE_COLOURS } from '@/data/constants';
import { ini } from '@/data/format';
import { orgName, roleLabel, sampleAccounts } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Person } from '@/data/types';
import { colors } from '@/theme';

/** Test key of a sample account: the role, or "freelancer" for Sofia. */
export const accountKey = (p: Pick<Person, 'role' | 'emp'>): string => (p.emp === 'freelancer' ? 'freelancer' : p.role);

/**
 * S5-LOGIN (DECISIONS 7): email + password (demo password "demo"), sample users that
 * fill the email and password. W3 owns this screen; F0 ships a working version.
 */
export function SignInScreen() {
  const { signIn } = useActions();
  const accounts = useAppState(sampleAccounts);
  const orgs = useAppState((s) => Object.fromEntries(accounts.map((p) => [p.id, orgName(s, p)])));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  
  const picked = email.trim().toLowerCase();

  const submit = () => {
    const r = signIn(email, password);
    if (!r.ok) setErr({ field: r.field, message: r.error });
  };

  return (
    <Screen title="Sign in" noHeader tabBar={false} testID="screen-sign-in">
      <Hero variant="plain" lead={<BrandMark />} eyebrow="Viljetech" title="Sign in" sub="Use your work email to continue." />
      <Form>
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(t) => {
            setEmail(t);
            setErr(null);
          }}
          placeholder="you@company.com"
          error={err?.field === 'email' ? err.message : undefined}
          testID="sign-in-email"
        />
        <TextField
          label="Password"
          type="password"
          value={password}
          onChange={(t) => {
            setPassword(t);
            setErr(null);
          }}
          placeholder="Password"
          error={err?.field === 'password' ? err.message : undefined}
          testID="sign-in-password"
        />
      </Form>
      <Button title="Sign in" onPress={submit} testID="sign-in-submit" />
      <TextBlock tone="info" text={`Demo password: ${DEMO_PASSWORD}. Pick a sample user to fill the email and password.`} />
      <Block title="Sample users" sub="One per user type">
        <Rows>
          {accounts.map((p) => (
            <Row
              key={p.id}
              lead={<TextTile text={ini(p.name)} />}
              title={p.name + (p.emp === 'freelancer' ? ' · Freelancer' : '')}
              sub={`${p.email} · ${orgs[p.id]}`}
              badge={{ label: roleLabel({ role: p.role }), tone: { bg: ROLE_COLOURS[p.role].bg, ink: ROLE_COLOURS[p.role].ink, dot: ROLE_COLOURS[p.role].ink } }}
              bg={picked === p.email ? colors.rowSelected : undefined}
              chevron={false}
              label={`Use ${p.name}`}
              onPress={() => {
                setEmail(p.email);
                setPassword(DEMO_PASSWORD);
                setErr(null);
              }}
              testID={`account-${accountKey(p)}`}
            />
          ))}
        </Rows>
      </Block>
    </Screen>
  );
}
