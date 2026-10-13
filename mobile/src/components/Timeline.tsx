import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Card } from './Card';
import { EmptyBlock } from './EmptyBlock';
import { MonoKey } from './Bits';
import { Press } from './Press';
import { Txt } from './Txt';

export interface TimelineItem {
  title: string;
  /** mono key (ticket key, version) and its colour */
  k?: string;
  kColor?: string;
  sub?: string;
  subColor?: string;
  /** right text (time, "Current step") */
  right?: string;
  /** dot colour and ring colour */
  dot: string;
  ring?: string;
  titleColor?: string;
  onPress?: () => void;
}

/**
 * Timeline (SPEC §6.2): 11px dot with a 3px ring and a 2px connector, mono key, title
 * 13.5/600, right text 11.5, sub 12.5. Used for deployments, follow-up ladders, dev
 * phases, bug progress and activity.
 */
export function Timeline({ items, empty, testID }: { items: TimelineItem[]; empty?: string; testID?: string }) {
  if (!items.length) return <EmptyBlock text={empty ?? 'Nothing here yet.'} />;
  return (
    <Card style={styles.card} testID={testID}>
      {items.map((x, i) => {
        const last = i === items.length - 1;
        const body = (
          <>
            <View style={styles.rail}>
              <View style={[styles.ring, { backgroundColor: x.ring ?? colors.track }]}>
                <View style={[styles.dot, { backgroundColor: x.dot }]} />
              </View>
              <View style={[styles.line, { backgroundColor: last ? colors.transparent : colors.ringCard }]} />
            </View>
            <View style={styles.main}>
              <View style={styles.top}>
                {x.k ? <MonoKey k={x.k} color={x.kColor ?? colors.ink3} size={12} /> : null}
                <Txt v="item" color={x.titleColor ?? colors.ink} style={styles.title}>
                  {x.title}
                </Txt>
                {x.right ? (
                  <Txt v="small" w={400} color={colors.ink3}>
                    {x.right}
                  </Txt>
                ) : null}
              </View>
              {x.sub ? (
                <Txt v="sub" color={x.subColor ?? colors.ink3} style={styles.sub}>
                  {x.sub}
                </Txt>
              ) : null}
            </View>
          </>
        );
        return x.onPress ? (
          <Press key={i} label={x.title} onPress={x.onPress} style={styles.item}>
            {body}
          </Press>
        ) : (
          <View key={i} style={styles.item}>
            {body}
          </View>
        );
      })}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 8, paddingHorizontal: 14 },
  item: { flexDirection: 'row', gap: 12 },
  rail: { width: 17, alignItems: 'center' },
  // 11px dot inside a 3px ring (the prototype's box-shadow); a transparent ring leaves the dot at 11px
  ring: { marginTop: 11, width: 17, height: 17, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 11, height: 11, borderRadius: 6 },
  line: { flex: 1, width: 2 },
  main: { flex: 1, minWidth: 0, paddingTop: 9, paddingBottom: 11 },
  top: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  title: { flex: 1, minWidth: 0 },
  sub: { marginTop: 2 },
});
