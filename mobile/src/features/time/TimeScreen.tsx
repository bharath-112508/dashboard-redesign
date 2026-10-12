import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Card } from '@/components/Card';
import { KeyChip } from '@/components/Chips';
import { StackedBar } from '@/components/DataDisplay';
import { Icon } from '@/components/Icon';
import { Press } from '@/components/Press';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { dow, hm, sh } from '@/data/format';
import { capabilities, me, weekData, weekTotals, type DayData } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { AppState } from '@/data/store/state';
import { openSheet } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';
import { colors, motion, radii } from '@/theme';

import { BillChip } from './BillChip';
import { INTERNAL } from './selectors';
import { WeekSwitcher } from './WeekSwitcher';

const DAY_SCALE = 10;

/** S-TIME Timesheet (tab root): week switcher, summary card and 7 day rows (M-15–M-19). */
export function TimeScreen() {
  const person = useAppState(me);
  const offset = useAppState((s) => s.ui.weekOffset);
  const dayOpen = useAppState((s) => s.ui.dayOpen);
  const days = useAppState((s) => weekData(s, s.ui.weekOffset));
  const { setUi } = useActions();
  if (!person?.role) return null;
  const free = !capabilities(person.role).showIdle;
  const tot = weekTotals(days);
  const scale = free ? Math.max(1, tot.total) : 40;

  return (
    <Screen
      title={tabTitle('time', person.role)}
      header="large"
      action={{ label: 'Log', icon: 'plus', onPress: () => openSheet('log-time'), testID: 'action-log' }}
      gap={12}
      testID="screen-time"
    >
      <WeekSwitcher offset={offset} onChange={(o) => setUi({ weekOffset: o, dayOpen: null })} showRelative />

      <Card pad={16} style={styles.summary} testID="time-summary">
        <View style={styles.totalRow}>
          <Txt v="display" testID="time-total">
            {hm(tot.total)}
          </Txt>
          <Txt v="bodyLg" w={500} color={colors.ink3}>
            {free ? 'logged' : 'of 40h'}
          </Txt>
        </View>
        <StackedBar
          height={10}
          gap={2}
          scale={scale}
          segments={[
            { value: tot.bill, color: colors.primary },
            { value: tot.non, color: colors.nonBillable },
            ...(free ? [] : [{ value: tot.idle, color: colors.idle }]),
          ]}
          label={`Billable ${hm(tot.bill)}, non-billable ${hm(tot.non)}${free ? '' : `, idle ${hm(tot.idle)}`}`}
        />
        <View style={styles.parts}>
          <Part label="Billable" value={hm(tot.bill)} color={colors.primary} />
          <Part label="Non-billable" value={hm(tot.non)} color={colors.nonBillable} />
          {free ? <View style={styles.part} /> : <Part label="Idle" value={hm(tot.idle)} color={colors.idle} />}
        </View>
      </Card>

      {days.map((d, i) => (
        <Animated.View key={d.d} style={motion.fadeUp(i, 0.05, 0.03)}>
          <DayRow day={d} open={dayOpen === d.d} onToggle={() => setUi({ dayOpen: dayOpen === d.d ? null : d.d })} />
        </Animated.View>
      ))}
    </Screen>
  );
}

function Part({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.part}>
      <View style={styles.partHead}>
        <View style={[styles.square, { backgroundColor: color }]} />
        <Txt v="meta" w={500} color={colors.ink3}>
          {label}
        </Txt>
      </View>
      <Txt v="section">{value}</Txt>
    </View>
  );
}

function DayRow({ day, open, onToggle }: { day: DayData; open: boolean; onToggle: () => void }) {
  const total = day.bill + day.non;
  const tickets = useAppState((s: AppState) => s.tickets);
  const name = dow(day.d);
  return (
    <Card pad={0} ring={day.isToday ? colors.primary : colors.line} style={styles.dayCard} testID={`day-${day.d}`}>
      <Press
        label={`${name} ${sh(day.d)}, ${total ? hm(total) : 'nothing logged'}`}
        onPress={onToggle}
        scale={1}
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        style={styles.dayHead}
        testID={`day-toggle-${day.d}`}
      >
        <View style={styles.dayName}>
          <Txt v="rowTitle" w={800} color={day.isToday ? colors.primaryInk : colors.ink}>
            {name}
          </Txt>
          <Txt v="meta" w={400} color={colors.ink3}>
            {sh(day.d)}
          </Txt>
        </View>
        <StackedBar
          style={styles.dayBar}
          height={8}
          scale={DAY_SCALE}
          segments={[
            { value: day.bill, color: colors.primary },
            { value: day.non, color: colors.nonBillable },
            { value: day.idle, color: colors.idle },
          ]}
        />
        <Txt v="rowTitle" w={800} style={styles.dayHours} align="right">
          {total ? hm(total) : '–'}
        </Txt>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <Icon name="chevron-down" size={18} color={colors.ink3} />
        </View>
      </Press>
      {open ? (
        <View style={styles.dayBody} testID="day-body">
          {day.entries.length === 0 ? (
            <Txt v="meta" w={400} color={colors.ink3} style={styles.nothing}>
              Nothing logged.
            </Txt>
          ) : (
            day.entries.map((e, i) => {
              const t = e.tk != null ? tickets.find((x) => x.id === e.tk) : undefined;
              return (
                <View key={String(e.id)} style={[styles.entry, i > 0 && styles.entryDivider]} testID="day-entry">
                  <View style={styles.entryText}>
                    <View style={styles.entryTitle}>
                      {t ? <KeyChip k={t.key} /> : null}
                      <Txt v="rowTitle" numberOfLines={1} style={styles.flex}>
                        {t ? t.title : e.text}
                      </Txt>
                    </View>
                    <Txt v="meta" w={400} color={colors.ink3} numberOfLines={1}>
                      {e.note || (t ? t.proj : e.proj || INTERNAL)}
                    </Txt>
                  </View>
                  <BillChip bill={e.bill} />
                  <Txt v="rowTitle" w={800} style={styles.entryHours} align="right">
                    {hm(e.h)}
                  </Txt>
                </View>
              );
            })
          )}
          {day.past ? (
            <Press
              label={`Log time for ${name}`}
              onPress={() => openSheet('log-time', { day: day.d })}
              scale={0.97}
              style={styles.logDay}
              testID="log-day"
            >
              <Txt v="bodySm" w={700} color={colors.primaryInk}>
                {`+ Log time for ${name}`}
              </Txt>
            </Press>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  summary: { gap: 14, borderRadius: radii.hero },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  parts: { flexDirection: 'row' },
  part: { flex: 1, gap: 4 },
  partHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  square: { width: 8, height: 8, borderRadius: 2 },
  dayCard: { overflow: 'hidden' },
  dayHead: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  dayName: { width: 44 },
  dayBar: { flex: 1 },
  dayHours: { minWidth: 64 },
  dayBody: { paddingHorizontal: 14, paddingBottom: 12, borderTopWidth: 1, borderTopColor: colors.divider, marginHorizontal: 0 },
  nothing: { paddingTop: 10, paddingBottom: 4 },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  entryDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  entryText: { flex: 1, gap: 3, minWidth: 0 },
  entryTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  entryHours: { minWidth: 40 },
  logDay: {
    marginTop: 8,
    height: 38,
    borderRadius: radii.iconButton,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
