import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Card } from './Card';
import { EmptyBlock } from './EmptyBlock';
import { Press } from './Press';
import { Txt } from './Txt';

export interface ProgressItem {
  title: string;
  /** amount used */
  used: number;
  /** budget / total; 0 = no bar */
  of: number;
  /** caption under the bar ("342h of 400h · 58h left") */
  caption?: string;
  /** value text (default the percentage) */
  value?: string;
  /** bar colour (default blue; amber at ≥85%; blue + red overflow when over) */
  color?: string;
  onPress?: () => void;
}

/**
 * Progress list (SPEC §6.2, the prototype's `PG`): title 13.5/600 + value 13/800, bar 7h
 * with a red overflow segment when over budget (red value and caption), caption 12.
 */
export function ProgressList({ items, empty, testID }: { items: ProgressItem[]; empty?: string; testID?: string }) {
  if (!items.length) return <EmptyBlock text={empty ?? 'Nothing here yet.'} />;
  return (
    <Card pad="sm" testID={testID}>
      {items.map((p, i) => {
        const ratio = p.of ? p.used / p.of : 0;
        const over = ratio > 1;
        const fill = Math.min(100, Math.round((over ? 1 / ratio : ratio) * 100));
        const overflow = over ? Math.round((1 - 1 / ratio) * 100) : 0;
        const color = p.color && !over ? p.color : over ? colors.primary : ratio >= 0.85 ? colors.amberDot : colors.primary;
        const body = (
          <>
            <View style={styles.top}>
              <Txt v="item" numberOfLines={1} style={styles.title}>
                {p.title}
              </Txt>
              <Txt v="label" w={800} color={over ? colors.danger : colors.ink}>
                {p.value ?? `${Math.round(ratio * 100)}%`}
              </Txt>
            </View>
            <View style={styles.track}>
              <View style={{ height: '100%', width: `${fill}%`, backgroundColor: color }} />
              {overflow ? <View style={{ height: '100%', width: `${overflow}%`, backgroundColor: colors.red }} /> : null}
            </View>
            {p.caption ? (
              <Txt v="meta" w={400} color={over ? colors.danger : colors.ink3} style={styles.caption}>
                {p.caption}
              </Txt>
            ) : null}
          </>
        );
        const style = [styles.item, i ? styles.divider : null];
        return p.onPress ? (
          <Press key={i} label={p.title} onPress={p.onPress} style={style}>
            {body}
          </Press>
        ) : (
          <View key={i} style={style}>
            {body}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  item: { paddingVertical: 10 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0 },
  track: { marginTop: 6, height: 7, borderRadius: 4, backgroundColor: colors.track, overflow: 'hidden', flexDirection: 'row' },
  caption: { marginTop: 4 },
});
