import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { ApproveButton, DestructiveButton } from '@/components/Buttons';
import { Card, ListCard, Section } from '@/components/Card';
import { StatusPill } from '@/components/Chips';
import { IconTile } from '@/components/IconTile';
import { showToast } from '@/components/Toast';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { LEAVE_STATUS } from '@/data/constants';
import { dateRange, dayCount } from '@/data/format';
import { capabilities, me, myLeaves, pendingApprovals } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Leave } from '@/data/types';
import { openSheet } from '@/nav/routes';
import { colors, motion, radii } from '@/theme';

/**
 * S-LEAVE Leave & comp-off (M-35 entry, M-36). Approvers (pm, admin, super) see the
 * requests waiting for them; everyone with leave sees their own requests.
 */
export function LeaveScreen() {
  const role = useAppState((s) => me(s)?.role ?? null);
  const pending = useAppState(pendingApprovals);
  const mine = useAppState(myLeaves);
  const { decideLeave } = useActions();
  const caps = role ? capabilities(role) : null;

  const decide = (l: Leave, st: 'Approved' | 'Rejected') => showToast(decideLeave(l.id, st));

  return (
    <Screen
      title="Leave & comp-off"
      action={caps?.hasLeave ? { label: '+ New', onPress: () => openSheet('leave'), testID: 'action-new-leave' } : undefined}
      gap={18}
      testID="screen-leave"
    >
      {caps?.canApprove ? (
        <Section title="Waiting for your approval" count={pending.length}>
          {pending.length === 0 ? (
            <Card testID="leave-caught-up">
              <Txt v="body" color={colors.ink3}>
                All caught up.
              </Txt>
            </Card>
          ) : (
            <View style={styles.list}>
              {pending.map((l, i) => (
                <Animated.View key={l.id} style={motion.fadeUp(i, 0.05, 0.05)}>
                  <Card style={styles.req} testID={`leave-pending-${l.id}`}>
                    <View style={styles.reqHead}>
                      <Avatar name={l.who} size={36} radius={10} />
                      <View style={styles.flex}>
                        <Txt v="rowTitle" w={800}>
                          {l.who}
                        </Txt>
                        <Txt v="meta" w={400} color={colors.ink3}>
                          {`${l.type} · ${dateRange(l.from, l.to)} · ${dayCount(l.from, l.to)}`}
                        </Txt>
                      </View>
                    </View>
                    <Txt v="bodyLg" color={colors.ink2}>
                      {l.reason}
                    </Txt>
                    <View style={styles.actions}>
                      <DestructiveButton
                        label="Reject"
                        a11yLabel={`Reject ${l.who}'s request`}
                        onPress={() => decide(l, 'Rejected')}
                        style={styles.btn}
                        testID={`leave-reject-${l.id}`}
                      />
                      <ApproveButton
                        label="Approve"
                        a11yLabel={`Approve ${l.who}'s request`}
                        onPress={() => decide(l, 'Approved')}
                        style={styles.btn}
                        testID={`leave-approve-${l.id}`}
                      />
                    </View>
                  </Card>
                </Animated.View>
              ))}
            </View>
          )}
        </Section>
      ) : null}

      {caps && !caps.isClient ? (
        <Section title="My requests" count={mine.length}>
          {mine.length === 0 ? (
            <Card>
              <Txt v="body" color={colors.ink3}>
                No requests yet.
              </Txt>
            </Card>
          ) : (
            <ListCard>
              {mine.map((l, i) => (
                <MyRequestRow key={l.id} leave={l} first={i === 0} />
              ))}
            </ListCard>
          )}
        </Section>
      ) : null}
    </Screen>
  );
}

/** One of my requests: type icon, "Type · dates", "N days · reason" (one line), status pill. */
function MyRequestRow({ leave: l, first }: { leave: Leave; first: boolean }) {
  const isLeave = l.type === 'Leave';
  return (
    <View
      style={[styles.mine, !first && styles.divider]}
      accessible
      accessibilityLabel={`${l.type} ${dateRange(l.from, l.to)}, ${dayCount(l.from, l.to)}, ${l.reason}, ${l.st}`}
      testID={`leave-mine-${l.id}`}
    >
      <IconTile
        icon={isLeave ? 'calendar-days' : 'calendar-clock'}
        bg={isLeave ? colors.violetSoft : colors.amberSoft}
        fg={isLeave ? colors.violetInk : colors.amberInk}
        size={34}
        radius={10}
        iconSize={18}
      />
      <View style={styles.flex}>
        <Txt v="rowTitle" numberOfLines={1}>
          {`${l.type} · ${dateRange(l.from, l.to)}`}
        </Txt>
        <Txt v="caption" color={colors.ink3} numberOfLines={1}>
          {`${dayCount(l.from, l.to)} · ${l.reason}`}
        </Txt>
      </View>
      <StatusPill label={l.st} tone={LEAVE_STATUS[l.st]} size="md" />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  list: { gap: 10 },
  req: { gap: 10 },
  reqHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, height: 42, borderRadius: radii.pill },
  mine: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
});
