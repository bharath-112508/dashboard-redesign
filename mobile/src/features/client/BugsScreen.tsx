import { StyleSheet, View } from 'react-native';

import { Card, EmptyState, KeyChip, Screen, StatusPill, Txt } from '@/components';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, openSheet, push } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';
import { colors, space } from '@/theme';

import { clientBugs, type BugCardVM } from './selectors';

/** S-BUGS: bugs and changes the client raised (client tab; header action "Report", M-21). */
export function BugsScreen() {
  const role = useAppState((s) => me(s)?.role ?? 'client');
  const bugs = useAppState(clientBugs);
  return (
    <Screen
      title={tabTitle('bugs', role)}
      header="large"
      gap={space.gap.cards}
      action={{ label: 'Report', onPress: () => openSheet('report'), testID: 'action-report' }}
      testID="screen-bugs"
    >
      {bugs.length ? bugs.map((b) => <BugCard key={b.id} b={b} />) : <EmptyState icon="bug-off" text="No bugs reported." />}
    </Screen>
  );
}

function BugCard({ b }: { b: BugCardVM }) {
  return (
    <Card onPress={() => push(href.ticket(b.id))} label={`${b.key} ${b.title}, ${b.status}`} style={styles.card} testID={`bug-card-${b.key}`}>
      <View style={styles.top}>
        <KeyChip k={b.key} />
        <StatusPill label={b.status} tone={b.tone} />
        <Txt v="small" w={400} color={colors.ink3} style={styles.date}>
          {b.raised}
        </Txt>
      </View>
      <Txt v="titleSm">{b.title}</Txt>
      <Txt v="meta" w={400} color={colors.ink3} numberOfLines={1}>
        {b.last}
      </Txt>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 7 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  date: { marginLeft: 'auto' },
});
