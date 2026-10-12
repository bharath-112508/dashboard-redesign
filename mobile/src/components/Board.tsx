import { ScrollView, StyleSheet, View } from 'react-native';

import { PRIORITY_DOT } from '@/data/constants';
import type { TicketPrio, TicketType } from '@/data/types';
import { colors, radii, shadows } from '@/theme';

import { AvatarStack } from './Avatar';
import { Dot, MonoKey, TypeTag } from './Bits';
import { Icon } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface BoardCardData {
  k: string;
  title: string;
  prio: TicketPrio;
  type: TicketType;
  due: string;
  dueColor?: string;
  /** "1/3" */
  subs?: string;
  comments?: number;
  /** avatars (staff viewers only) */
  people?: string[];
  onPress?: () => void;
}

export interface BoardColumn {
  key: string;
  name: string;
  dot: string;
  cards: BoardCardData[];
}

/** Board card (SPEC §6.2 / S5-PROJECT Board): r12, priority dot, key, due, title, type tag, subtasks, comments, avatars. */
export function BoardCard(c: BoardCardData) {
  return (
    <Press label={`${c.k} ${c.title}`} onPress={c.onPress} disabled={!c.onPress} style={styles.card} testID={`board-card-${c.k}`}>
      <View style={styles.cardTop}>
        <Dot color={PRIORITY_DOT[c.prio]} />
        <MonoKey k={c.k} />
        <Txt v="small" w={600} color={c.dueColor ?? colors.ink3} style={styles.due}>
          {c.due}
        </Txt>
      </View>
      <Txt v="item" style={styles.cardTitle}>
        {c.title}
      </Txt>
      <View style={styles.cardFoot}>
        <TypeTag type={c.type} />
        {c.subs ? (
          <View style={styles.meta}>
            <Icon name="list-checks" size={12} color={colors.ink3} />
            <Txt v="small" w={400} color={colors.ink3}>
              {c.subs}
            </Txt>
          </View>
        ) : null}
        {c.comments ? (
          <View style={styles.meta}>
            <Icon name="message-square" size={12} color={colors.ink3} />
            <Txt v="small" w={400} color={colors.ink3}>
              {String(c.comments)}
            </Txt>
          </View>
        ) : null}
        <View style={styles.people}>{c.people?.length ? <AvatarStack names={c.people} /> : null}</View>
      </View>
    </Press>
  );
}

/**
 * Board (SPEC §6.2): horizontal, snapping columns 272 wide on #EDF1F6, radius 16; an
 * empty column says "Nothing here". Bleeds into the 16px gutter.
 */
export function Board({ columns, testID }: { columns: BoardColumn[]; testID?: string }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={282}
      decelerationRate="fast"
      style={styles.bleed}
      contentContainerStyle={styles.cols}
      testID={testID}
    >
      {columns.map((col) => (
        <View key={col.key} style={styles.col} testID={`board-col-${col.key}`}>
          <View style={styles.colHead}>
            <Dot color={col.dot} />
            <Txt v="label" w={800}>
              {col.name}
            </Txt>
            <Txt v="meta" w={700} color={colors.ink3} style={styles.count}>
              {String(col.cards.length)}
            </Txt>
          </View>
          {col.cards.map((c) => (
            <BoardCard key={c.k} {...c} />
          ))}
          {!col.cards.length ? (
            <Txt v="sub" color={colors.ink3} align="center" style={styles.empty}>
              Nothing here
            </Txt>
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -16, flexGrow: 0 },
  cols: { gap: 10, paddingHorizontal: 16, paddingBottom: 4 },
  col: { width: 272, borderRadius: radii.card, backgroundColor: colors.boardCol, padding: 10, gap: 8 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 4, paddingVertical: 2 },
  count: { marginLeft: 'auto' },
  card: { borderRadius: 12, backgroundColor: colors.surface, paddingVertical: 11, paddingHorizontal: 12, ...shadows.boardCard },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  due: { marginLeft: 'auto' },
  cardTitle: { marginTop: 5, lineHeight: 18 },
  cardFoot: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  people: { marginLeft: 'auto' },
  empty: { padding: 14 },
});
