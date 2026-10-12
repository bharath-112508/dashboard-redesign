/** Small building blocks shared by the project screens (feature-local). */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { AvatarStack, Card, CriticalBadge, Icon, KeyChip, Press, TypeIcon, Txt, type IconName } from '@/components';
import { PROJECT_STATUS } from '@/data/constants';
import { myRole, ticketCardVM } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { ProjectStatus, Ticket } from '@/data/types';
import { toTicket } from '@/nav/routes';
import { colors, motion, radii } from '@/theme';

import type { RequestVM, TaskVM } from './maintenance';

/** Sub-view enter animation (tc-fade-up .3s). */
export function ViewIn({ children, gap = 12, style }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle> }) {
  return <Animated.View style={[{ gap }, motion.fadeUp(0, 0, 0, 0.3), style]}>{children}</Animated.View>;
}

/** Uppercase eyebrow above a card list ("YOUR REQUESTS"). */
export function Eyebrow4({ children, color = colors.ink3 }: { children: string; color?: string }) {
  return (
    <Txt v="eyebrow" color={color} style={styles.eyebrow} accessibilityRole="header">
      {children}
    </Txt>
  );
}

/** Compact ticket card of the project List and Board views (prototype card, radius 16). */
export function ProjectTicketCard({ ticket }: { ticket: Ticket }) {
  const isClient = useAppState((s) => myRole(s) === 'client');
  const vm = ticketCardVM(ticket, isClient);
  return (
    <Card
      onPress={() => toTicket(ticket.id)}
      label={`${vm.key} ${vm.title}, ${vm.statusLabel}, due ${vm.due.label}`}
      ring={vm.ring}
      radius={radii.compactCard}
      pad={12}
      style={styles.tcard}
      testID={`ticket-card-${vm.key}`}
    >
      <View style={styles.row7}>
        <TypeIcon type={vm.type} />
        <KeyChip k={vm.key} />
        <View style={styles.flex} />
        {vm.critical ? <CriticalBadge /> : null}
      </View>
      <Txt v="bodyLg" w={700} style={styles.tTitle} numberOfLines={2}>
        {vm.title}
      </Txt>
      <View style={styles.row8}>
        <AvatarStack names={vm.assignees} size={22} />
        <Txt v="small" w={400} color={colors.ink3} style={[styles.flex, styles.ml6]} numberOfLines={1}>
          {`${vm.epic} · ${vm.sprint}`}
        </Txt>
        <Txt v="small" w={vm.due.weight} color={vm.due.color}>
          {vm.due.label}
        </Txt>
      </View>
    </Card>
  );
}

/** Project status pill; a button with a chevron for staffAll (opens the status sheet). */
export function ProjectStatusButton({ status, canSet, onPress }: { status: ProjectStatus; canSet: boolean; onPress: () => void }) {
  const st = PROJECT_STATUS[status];
  const body = (
    <>
      <Txt v="caption" w={700} color={st.ink} numberOfLines={1}>
        {st.label}
      </Txt>
      {canSet ? <Icon name="chevron-down" size={14} color={st.ink} strokeWidth={2.4} /> : null}
    </>
  );
  const style = [styles.statusBtn, { backgroundColor: st.soft }];
  if (!canSet) {
    return (
      <View style={style} accessible accessibilityLabel={`Status: ${st.label}`} testID="project-status-pill">
        {body}
      </View>
    );
  }
  return (
    <Press label={`Status: ${st.label}. Change project status`} onPress={onPress} style={style} scale={0.97} testID="project-status-pill">
      {body}
    </Press>
  );
}

/** Grey info tile with an uppercase label ("FIRST REPLY", "LAST INCIDENT"). */
export function InfoTile({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <View style={styles.infoTile}>
      <Txt v="eyebrow" color={colors.ink3} style={styles.infoLabel}>
        {label}
      </Txt>
      <Txt v={small ? 'meta' : 'body'} w={small ? 700 : 800} style={styles.mt3}>
        {value}
      </Txt>
    </View>
  );
}

/** Card holding rows separated by hairlines (requests, releases, tasks, files). */
export function RowsCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.rowsCard} testID={testID}>
      {children}
    </View>
  );
}

/** Support request row (SPEC S-PROJECT Support). Staff get the billing chip and Assign. */
export function RequestRow({ r, first, staff, onToggleBill, onAssign }: { r: RequestVM; first?: boolean; staff?: boolean; onToggleBill?: () => void; onAssign?: () => void }) {
  return (
    <View style={[styles.req, !first && styles.divider]} testID={`request-${r.id}`}>
      <View style={styles.reqHead}>
        <KeyChip k={r.id} />
        <View style={[styles.prioChip, { backgroundColor: r.prioTone.soft }]}>
          <Txt v="chip" color={r.prioTone.ink}>{`${r.type} · ${r.prio}`}</Txt>
        </View>
        <View style={styles.flex} />
        <View style={[styles.stPill, { backgroundColor: r.statusTone.soft }]}>
          <Txt v="small" w={700} color={r.statusTone.ink}>
            {r.statusLabel}
          </Txt>
        </View>
      </View>
      <Txt v="rowTitle" style={styles.lh13}>
        {r.t}
      </Txt>
      <View style={styles.reqFoot}>
        <Txt v="caption" w={600} color={r.whoColor}>
          {r.who}
        </Txt>
        <Txt v="caption" w={600} color={r.slaColor} align="right" style={styles.flexShrink}>
          {r.sla}
        </Txt>
      </View>
      {staff ? (
        <View style={styles.reqActions}>
          <Press
            label={`${r.id}: ${r.billLabel}. Toggle billing`}
            onPress={onToggleBill}
            style={[styles.smallChip, { backgroundColor: r.billTone.soft }]}
            scale={0.97}
            testID={`bill-${r.id}`}
          >
            <Icon name="repeat-2" size={13} color={r.billTone.ink} strokeWidth={2.4} />
            <Txt v="small" w={700} color={r.billTone.ink}>
              {r.billLabel}
            </Txt>
          </Press>
          {r.canAssign ? (
            <Press label={`Assign ${r.id} to me`} onPress={onAssign} style={[styles.smallChip, styles.assign]} scale={0.97} testID={`assign-${r.id}`}>
              <Txt v="small" w={700}>
                Assign
              </Txt>
            </Press>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Upkeep task row: tap to toggle done (M-32). */
export function TaskRow({ t, first, onToggle }: { t: TaskVM; first?: boolean; onToggle: () => void }) {
  return (
    <Press
      label={`${t.title}, ${t.done ? 'done' : 'not done'}`}
      a11yRole="checkbox"
      checked={t.done}
      onPress={onToggle}
      scale={1}
      style={[styles.task, !first && styles.divider]}
      testID={`task-${t.id}`}
    >
      <Icon name={t.done ? 'circle-check' : 'circle'} size={20} color={t.done ? colors.green : colors.faint} />
      <View style={styles.flex}>
        <Txt v="bodyLg" w={700} color={t.done ? colors.muted : colors.ink} style={[styles.lhTight, t.done && styles.strike]}>
          {t.title}
        </Txt>
        <Txt v="small" w={400} color={colors.ink3}>
          {t.who}
        </Txt>
      </View>
      <Txt v="caption" w={700} color={t.dueColor}>
        {t.dueLabel}
      </Txt>
    </Press>
  );
}

/** Round 46px button with an icon (dark or outline), as in the Support views. */
export function PillButton({ label, icon, onPress, dark, testID, style }: { label: string; icon: IconName; onPress: () => void; dark?: boolean; testID?: string; style?: StyleProp<ViewStyle> }) {
  const fg = dark ? colors.white : colors.ink;
  return (
    <Press label={label} onPress={onPress} scale={0.97} style={[styles.pill, dark ? styles.pillDark : styles.pillLight, style]} testID={testID}>
      <Icon name={icon} size={16} color={fg} strokeWidth={2.2} />
      <Txt v="body" w={700} color={fg} numberOfLines={1}>
        {label}
      </Txt>
    </Press>
  );
}

/** Small 34px pill button ("Edit plan", "Report"). */
export function SmallPill({ label, icon, onPress, dark, testID }: { label: string; icon: IconName; onPress: () => void; dark?: boolean; testID?: string }) {
  const fg = dark ? colors.white : colors.ink;
  return (
    <Press label={label} onPress={onPress} scale={0.97} style={[styles.small, dark ? styles.pillDark : styles.pillLight]} testID={testID}>
      <Icon name={icon} size={14} color={fg} strokeWidth={2.2} />
      <Txt v="meta" w={700} color={fg}>
        {label}
      </Txt>
    </Press>
  );
}

export const partStyles = StyleSheet.create({
  card: { padding: 14, borderRadius: radii.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 10 },
  grid2: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  ml6: { marginLeft: 6 },
  mt3: { marginTop: 3 },
  lh13: { lineHeight: 19.5 },
  lhTight: { lineHeight: 19 },
  strike: { textDecorationLine: 'line-through' },
  eyebrow: { paddingHorizontal: 4 },
  tcard: { gap: 8 },
  tTitle: { lineHeight: 19 },
  row7: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 10, borderRadius: 14, flexShrink: 0 },
  infoTile: { flex: 1, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.bg },
  infoLabel: { fontSize: 11, letterSpacing: 0.66 },
  rowsCard: { borderRadius: radii.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  req: { gap: 7, paddingVertical: 13, paddingHorizontal: 14 },
  reqHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  prioChip: { paddingHorizontal: 7, height: 21, borderRadius: 5, justifyContent: 'center' },
  stPill: { paddingHorizontal: 9, height: 24, borderRadius: radii.pill, justifyContent: 'center' },
  reqFoot: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  reqActions: { flexDirection: 'row', gap: 6 },
  smallChip: { height: 30, paddingHorizontal: 11, borderRadius: 15, flexDirection: 'row', alignItems: 'center', gap: 5 },
  assign: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  task: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14 },
  pill: { height: 46, borderRadius: 23, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12 },
  pillDark: { backgroundColor: colors.ink },
  pillLight: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  small: { height: 34, paddingHorizontal: 14, borderRadius: 17, flexDirection: 'row', alignItems: 'center', gap: 5 },
});
