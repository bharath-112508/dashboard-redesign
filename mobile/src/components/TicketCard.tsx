import { StyleSheet, View } from 'react-native';

import { myRole, ticketCardVM } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { Ticket } from '@/data/types';
import { toTicket } from '@/nav/routes';
import { colors, radii } from '@/theme';

import { AvatarStack } from './Avatar';
import { Card } from './Card';
import { CriticalBadge, Dot, KeyChip } from './Chips';
import { ProgressBar } from './DataDisplay';
import { PriorityGlyph, TypeIcon } from './TicketBits';
import { Txt } from './Txt';

export interface TicketCardProps {
  ticket: Ticket;
  /** full (Tickets tab, Ticket board) or compact (project List / Board) */
  variant?: 'full' | 'compact';
  /** default opens the ticket (M-11) */
  onPress?: () => void;
}

/** Ticket card (SPEC S-TICKETS). Clients see client status labels and no Critical badge. */
export function TicketCard({ ticket, variant = 'full', onPress }: TicketCardProps) {
  const isClient = useAppState((s) => myRole(s) === 'client');
  const vm = ticketCardVM(ticket, isClient);
  const open = onPress ?? (() => toTicket(ticket.id));
  const label = `${vm.key} ${vm.title}, ${vm.statusLabel}, due ${vm.due.label}`;

  if (variant === 'compact') {
    return (
      <Card onPress={open} label={label} ring={vm.ring} radius={radii.compactCard} pad={12} style={styles.gap8} testID={`ticket-card-${vm.key}`}>
        <View style={styles.row}>
          <TypeIcon type={vm.type} />
          <KeyChip k={vm.key} />
          {vm.critical ? <CriticalBadge /> : null}
        </View>
        <Txt v="rowTitle" numberOfLines={2}>
          {vm.title}
        </Txt>
        <View style={styles.row}>
          <AvatarStack names={vm.assignees} size={22} />
          <Txt v="small" w={400} color={colors.ink3} style={styles.flex} numberOfLines={1}>
            {`${vm.epic} · ${vm.sprint}`}
          </Txt>
          <Txt v="small" w={vm.due.weight} color={vm.due.color}>
            {vm.due.label}
          </Txt>
        </View>
      </Card>
    );
  }

  return (
    <Card onPress={open} label={label} ring={vm.ring} style={styles.gap8} testID={`ticket-card-${vm.key}`}>
      <View style={styles.row}>
        <TypeIcon type={vm.type} />
        <KeyChip k={vm.key} />
        <View style={styles.flex} />
        {vm.critical ? <CriticalBadge /> : <PriorityGlyph prio={vm.prio} asClient />}
      </View>
      <Txt v="cardTitle" numberOfLines={2}>
        {vm.title}
      </Txt>
      <View style={styles.row}>
        <Dot color={vm.statusDot} size={7} />
        <Txt v="bodySm" w={600} color={colors.ink2}>
          {vm.statusLabel}
        </Txt>
        <Txt v="bodySm" w={400} color={colors.ink3} style={styles.flex} numberOfLines={1}>
          {vm.proj}
        </Txt>
        <Txt v="bodySm" w={vm.due.weight} color={vm.due.color}>
          {vm.due.label}
        </Txt>
      </View>
      <View style={styles.foot}>
        <AvatarStack names={vm.assignees} size={24} />
        <View style={styles.subs}>
          <Txt v="meta" w={600} color={vm.hasSubs ? colors.ink : colors.faint} align="right">
            {vm.subsLabel}
          </Txt>
          <ProgressBar pct={vm.subsPct} height={4} label={vm.subsLabel} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  gap8: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
    paddingTop: 10,
    marginTop: 2,
  },
  subs: { flex: 1, maxWidth: 120, marginLeft: 'auto', gap: 6 },
});
