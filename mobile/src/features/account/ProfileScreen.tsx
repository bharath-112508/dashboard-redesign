import { StyleSheet, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { DestructiveButton } from '@/components/Buttons';
import { Card, ListCard, ListRow, type ListRowProps } from '@/components/Card';
import { Toggle } from '@/components/Controls';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { capabilities, me, pendingApprovals, unreadCount } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { goTab, href, push } from '@/nav/routes';
import { colors } from '@/theme';

/** S-ME Profile (M-08, M-09, M-03, M-04). */
export function ProfileScreen() {
  const person = useAppState(me);
  const unread = useAppState(unreadCount);
  const toApprove = useAppState((s) => pendingApprovals(s).length);
  const pushOn = useAppState((s) => s.push);
  const { setPush, switchAccount, signOut } = useActions();
  if (!person?.role) return null;
  const caps = capabilities(person.role);

  type Row = Omit<ListRowProps, 'first'> & { key: string; show: boolean };
  const rows: Row[] = [
    {
      key: 'leave',
      show: caps.hasLeave,
      title: 'Leave & comp-off',
      sub: caps.canApprove && toApprove ? `${toApprove} waiting for approval` : 'Requests and status',
      icon: 'calendar-days',
      iconBg: colors.violetSoft,
      iconFg: colors.violetInk,
      onPress: () => push(href.leave()),
    },
    {
      key: 'time',
      show: !caps.isClient,
      title: 'Timesheet',
      sub: 'Your hours by week',
      icon: 'clock-3',
      iconBg: colors.primarySoft2,
      iconFg: colors.primaryInk,
      onPress: () => goTab('time'),
    },
    {
      key: 'inbox',
      show: true,
      title: 'Notifications',
      sub: unread ? `${unread} unread` : 'All read',
      icon: 'bell',
      iconBg: colors.amberSoft,
      iconFg: colors.amberInk,
      onPress: () => push(href.inbox()),
    },
    {
      key: 'push',
      show: true,
      title: 'Push notifications',
      sub: pushOn ? 'On' : 'Off',
      icon: 'bell',
      iconBg: colors.greenSoft,
      iconFg: colors.greenInk,
      trailing: <Toggle label="Push notifications" value={pushOn} onChange={setPush} />,
    },
    {
      key: 'switch-account',
      show: true,
      title: 'Switch account',
      sub: 'Try another role',
      icon: 'repeat-2',
      iconBg: colors.track,
      iconFg: colors.ink2,
      onPress: switchAccount,
    },
  ];

  return (
    <Screen title="Profile" gap={14} testID="screen-me">
      <Card pad={16} radius={24} style={styles.card} testID="me-card">
        <Avatar name={person.name} size={64} radius={18} bg={person.client ? colors.ink : undefined} />
        <View style={styles.flex}>
          <Txt v="titleMd" numberOfLines={1}>
            {person.name}
          </Txt>
          <Txt v="rowTitle" w={600} color={colors.ink2} numberOfLines={1}>
            {person.title}
          </Txt>
          <Txt v="body" color={colors.ink3} numberOfLines={1}>
            {person.email}
          </Txt>
        </View>
      </Card>
      <ListCard>
        {rows
          .filter((r) => r.show)
          .map(({ key, show: _show, ...r }, i) => (
            <ListRow key={key} {...r} first={i === 0} testID={`me-${key}`} />
          ))}
      </ListCard>
      <DestructiveButton label="Sign out" onPress={signOut} testID="me-sign-out" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 16 },
});
