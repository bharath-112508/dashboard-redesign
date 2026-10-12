import { StyleSheet, View } from 'react-native';

import { Dot } from '@/components/Chips';
import { SegmentedControl } from '@/components/Controls';
import { EmptyState } from '@/components/EmptyState';
import { Screen } from '@/components/Screen';
import { TicketCard } from '@/components/TicketCard';
import { Txt } from '@/components/Txt';
import { me } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketFilter } from '@/data/store/state';
import { tabTitle } from '@/nav/titles';
import { colors } from '@/theme';

import { ticketFilterCounts, ticketGroups } from './selectors';

export interface TicketsScreenProps {
  /** tab root (large header) or the pushed copy from More (small header) */
  pushed?: boolean;
}

/** S-TICKETS: my tickets (all tickets for staffAll), filtered and bucketed by due date. */
export function TicketsScreen({ pushed }: TicketsScreenProps) {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  const filter = useAppState((s) => s.ui.ticketFilter);
  const counts = useAppState(ticketFilterCounts);
  const groups = useAppState((s) => ticketGroups(s, filter));
  const { setUi } = useActions();

  return (
    <Screen
      title={pushed ? 'Tickets' : tabTitle('tickets', role)}
      header={pushed ? 'small' : 'large'}
      gap={16}
      testID={pushed ? 'screen-stack-tickets' : 'screen-tickets'}
    >
      <SegmentedControl<TicketFilter>
        label="Ticket filter"
        value={filter}
        onChange={(k) => setUi({ ticketFilter: k })}
        segments={[
          { key: 'open', label: 'Open', count: counts.open },
          { key: 'done', label: 'Done', count: counts.done },
          { key: 'all', label: 'All', count: counts.all },
        ]}
        style={pushed ? styles.pushedSeg : undefined}
      />
      {groups.map((g) => (
        <View key={g.key} style={styles.group} testID={`ticket-group-${g.key}`}>
          <View style={styles.groupHead} accessibilityRole="header" accessibilityLabel={`${g.label}, ${g.tickets.length}`}>
            <Dot color={g.dot} size={8} />
            <Txt v="rowTitle" w={800} color={g.ink}>
              {g.label}
            </Txt>
            <Txt v="meta" w={700} color={colors.ink3}>
              {String(g.tickets.length)}
            </Txt>
          </View>
          <View style={styles.cards}>
            {g.tickets.map((t) => (
              <TicketCard key={t.id} ticket={t} />
            ))}
          </View>
        </View>
      ))}
      {!groups.length ? <EmptyState icon="inbox" text="Nothing here." /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pushedSeg: { marginTop: 8 },
  group: { gap: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  cards: { gap: 8 },
});
