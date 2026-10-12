import { StyleSheet, View } from 'react-native';

import { PRIORITY, TICKET_TYPE } from '@/data/constants';
import type { TicketPrio, TicketType } from '@/data/types';
import { colors } from '@/theme';

import { CriticalBadge } from './Chips';
import { Icon } from './Icon';
import { Txt } from './Txt';

/** Ticket type tile: Bug / Task / Story (20px, radius 5). */
export function TypeIcon({ type, size = 20 }: { type: TicketType; size?: number }) {
  const t = TICKET_TYPE[type];
  return (
    <View
      style={[styles.type, { width: size, height: size, borderRadius: Math.round(size / 4), backgroundColor: t.soft }]}
      accessible
      accessibilityLabel={type}
    >
      <Icon name={t.icon} size={Math.round(size * 0.65)} color={t.ink} />
    </View>
  );
}

/**
 * Priority glyph and label. Critical shows the red badge for staff; pass
 * `asClient` to show Critical as High without a badge (SPEC §2.1).
 */
export function PriorityGlyph({ prio, asClient, showLabel = true }: { prio: TicketPrio; asClient?: boolean; showLabel?: boolean }) {
  if (prio === 'Critical' && !asClient) return <CriticalBadge />;
  const p = prio === 'Critical' ? 'High' : prio;
  const g = PRIORITY[p];
  return (
    <View style={styles.prio} accessible accessibilityLabel={`${p} priority`}>
      <Icon name={g.icon} size={16} color={g.color} strokeWidth={2.4} />
      {showLabel ? (
        <Txt v="bodySm" w={600} color={colors.ink2}>
          {p}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  type: { alignItems: 'center', justifyContent: 'center' },
  prio: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
