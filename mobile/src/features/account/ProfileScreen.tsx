import { useState } from 'react';

import { Avatar, IconTile } from '@/components/Avatar';
import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { Form, SelectField, TextField } from '@/components/fields';
import { Hero } from '@/components/Hero';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { showToast } from '@/components/Toast';
import { TIME_ZONES } from '@/data/constants';
import { isClientRole, me, orgName, roleLabel } from '@/data/selectors';
import { store, useActions, useAppState } from '@/data/store';
import type { NotifPrefs } from '@/data/types';
import { colors } from '@/theme';

const NOTIFS: { key: keyof NotifPrefs; title: string; sub: string; staff?: boolean }[] = [
  { key: 'tickets', title: 'Ticket assigned to me', sub: 'When someone assigns or mentions you' },
  { key: 'due', title: 'Due date reminders', sub: 'The day before a ticket is due', staff: true },
  { key: 'questions', title: 'Client replies', sub: 'When a client answers a question' },
  { key: 'weekly', title: 'Weekly timesheet reminder', sub: 'Fridays at 15:00 if hours are missing', staff: true },
];

const ALL_ON: NotifPrefs = { tickets: true, due: true, questions: true, weekly: true };

/**
 * S5-PROFILE Profile settings (V-04): details, notification preferences, password,
 * Save changes, Sign out (V-03).
 */
export function ProfileScreen() {
  const u = useAppState(me);
  const org = useAppState((s) => (u ? orgName(s, u) : ''));
  const { saveProfile, signOut } = useActions();
  const [init] = useState(() => me(store.getState()));
  const [name, setName] = useState(init?.name ?? '');
  const [phone, setPhone] = useState(init?.phone ?? '');
  const [tz, setTz] = useState(init?.tz ?? 'Europe/Oslo');
  const [notif, setNotif] = useState<NotifPrefs>({ ...ALL_ON, ...(init?.notif ?? {}) });
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  if (!u) return null;
  const client = isClientRole(u.role);
  const save = () => {
    const r = saveProfile({ name, phone, tz, notif, password: pw1, repeat: pw2 });
    if (!r.ok) {
      setErr({ field: r.field, message: r.error });
      return;
    }
    setErr(null);
    setPw1('');
    setPw2('');
    showToast(r.toast);
  };
  const pwErr = err && (err.field === 'password' || err.field === 'repeat') ? err.message : undefined;
  return (
    <Screen title="Profile settings" sub={`${roleLabel(u)} · ${org}`} testID="screen-me">
      <Hero lead={<Avatar name={u.name} size={46} radius={13} />} eyebrow="Profile settings" title={name || u.name} sub={u.email} testID="profile-hero" />
      <Block title="Personal details">
        <Form>
          <TextField
            label="Full name"
            required
            value={name}
            onChange={(t) => {
              setName(t);
              setErr(null);
            }}
            error={err?.field === 'name' ? err.message : undefined}
            testID="profile-name"
          />
          <TextField label="Email" value={u.email} readOnly testID="profile-email" />
          <TextField label="Phone" value={phone} onChange={setPhone} placeholder="+47 …" testID="profile-phone" />
          <SelectField label="Time zone" value={tz} options={TIME_ZONES.map((z) => ({ value: z, label: z }))} onChange={setTz} testID="profile-tz" />
        </Form>
      </Block>
      <Block title="Notifications">
        <Rows testID="profile-notifs">
          {NOTIFS.filter((n) => !(client && n.staff)).map((n) => (
            <Row key={n.key} title={n.title} sub={n.sub} subWrap toggle={notif[n.key]} onPress={() => setNotif({ ...notif, [n.key]: !notif[n.key] })} testID={`notif-${n.key}`} />
          ))}
          {client ? null : (
            <Row
              lead={<IconTile icon="rocket" bg={colors.greenSoft} fg={colors.greenInk} />}
              title="Deployments"
              sub="Always on. You are notified each time a project goes live or is rolled back."
              subWrap
            />
          )}
        </Rows>
      </Block>
      <Block title="Change password">
        <Form>
          <TextField
            label="New password"
            type="password"
            value={pw1}
            onChange={(t) => {
              setPw1(t);
              setErr(null);
            }}
            placeholder="At least 8 characters"
            testID="profile-pw1"
          />
          <TextField
            label="Repeat password"
            type="password"
            value={pw2}
            onChange={(t) => {
              setPw2(t);
              setErr(null);
            }}
            error={pwErr}
            testID="profile-pw2"
          />
        </Form>
      </Block>
      <Button title="Save changes" onPress={save} testID="profile-save" />
      <Button title="Sign out" icon="log-out" kind="d" onPress={signOut} testID="profile-sign-out" />
    </Screen>
  );
}
