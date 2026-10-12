import { ScrollView, StyleSheet, View } from 'react-native';

import { Dot } from '@/components/Chips';
import { ChipRow, SegmentedControl } from '@/components/Controls';
import { Screen } from '@/components/Screen';
import { TicketCard } from '@/components/TicketCard';
import { Txt } from '@/components/Txt';
import { useActions, useAppState } from '@/data/store';
import { colors, radii, space } from '@/theme';

import { boardColumns, boardSprintGroups, boardState } from './selectors';

const COL_W = 280;
const COL_GAP = 10;

/** S-BOARD: ticket board per project and epic, as status columns or sprint lists (M-43). */
export function BoardScreen() {
  const b = useAppState(boardState);
  const { setUi } = useActions();

  return (
    <Screen title="Ticket board" gap={12} contentStyle={styles.content} testID="screen-board">
      <ChipRow
        label="Project"
        value={b.project}
        onChange={(p) => setUi({ boardProject: p, boardEpic: 'all' })}
        options={b.projects.map((p) => ({ key: p, label: p }))}
        style={styles.chips}
      />
      <ChipRow
        label="Epic"
        value={b.epic}
        onChange={(e) => setUi({ boardEpic: e })}
        options={[{ key: 'all', label: 'All epics' }, ...b.epics.map((e) => ({ key: e, label: e }))]}
        style={styles.chips}
      />
      <SegmentedControl
        variant="pill"
        label="Board view"
        value={b.view}
        onChange={(v) => setUi({ boardView: v })}
        segments={[
          { key: 'board', label: 'Board', icon: 'square-kanban' },
          { key: 'list', label: 'List', icon: 'list' },
        ]}
        testIDPrefix="board-view-"
      />

      {b.view === 'board' ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={COL_W + COL_GAP}
          decelerationRate="fast"
          style={styles.colScroll}
          contentContainerStyle={styles.colInner}
          testID="board-columns"
        >
          {boardColumns(b.tickets).map((c) => (
            <View key={c.st} style={styles.col} testID={`board-col-${c.st}`}>
              <View style={styles.colHead}>
                <Dot color={c.dot} size={8} />
                <Txt v="bodyLg" w={800} style={styles.colTitle}>
                  {c.label}
                </Txt>
                <Txt v="meta" w={700} color={colors.ink3}>
                  {String(c.tickets.length)}
                </Txt>
              </View>
              {c.tickets.map((t) => (
                <TicketCard key={t.id} ticket={t} />
              ))}
              {!c.tickets.length ? (
                <Txt v="meta" w={400} color={colors.ink3} align="center" style={styles.colEmpty}>
                  No tickets
                </Txt>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : (
        boardSprintGroups(b.tickets).map((g) => (
          <View key={g.label} style={styles.group} testID={`board-group-${g.label}`}>
            <View style={styles.groupHead}>
              <Txt v="rowTitle" w={800}>
                {g.label}
              </Txt>
              <Txt v="meta" w={700} color={colors.ink3}>
                {String(g.tickets.length)}
              </Txt>
            </View>
            {g.tickets.map((t) => (
              <TicketCard key={t.id} ticket={t} />
            ))}
          </View>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  chips: { flexGrow: 0, marginHorizontal: -2, paddingVertical: 2 },
  colScroll: { marginHorizontal: -space.gutter, flexGrow: 0 },
  colInner: { paddingHorizontal: space.gutter, paddingBottom: 6, gap: COL_GAP },
  col: { width: COL_W, gap: 8, padding: 10, borderRadius: radii.boardCol, backgroundColor: colors.boardCol },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, paddingVertical: 2 },
  colTitle: { lineHeight: 20 },
  colEmpty: { padding: 18 },
  group: { gap: 8 },
  groupHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4 },
});
