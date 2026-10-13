import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

import { Press } from './Press';
import { Txt } from './Txt';

export interface DayCell {
  date: string;
  /** "Mon" */
  day: string;
  /** "5" */
  num: string;
  /** logged hours text ("7h 30m", "–") */
  hours: string;
  /** short past weekday (hours in #A5502C) */
  short?: boolean;
  today?: boolean;
}

/** Day strip (SPEC §6.2): 7 equal cells 64h r12; selected ink-filled (also when it is today, as the prototype), an unselected today gets a blue border. */
export function DayStrip({ days, selected, onSelect }: { days: DayCell[]; selected: string; onSelect: (date: string) => void }) {
  return (
    <View style={styles.row}>
      {days.map((d) => {
        const on = d.date === selected;
        const fg = on ? colors.white : colors.ink;
        return (
          <Press
            key={d.date}
            label={`${d.day} ${d.num}, ${d.hours}`}
            a11yRole="button"
            selected={on}
            onPress={() => onSelect(d.date)}
            style={[styles.cell, { backgroundColor: on ? colors.ink : colors.surface, borderColor: on ? colors.ink : d.today ? colors.primary : colors.ringCard }]}
            testID={`day-${d.date}`}
          >
            <Txt v="tab" color={fg} style={styles.dim}>
              {d.day}
            </Txt>
            <Txt v="section" w={800} color={fg} style={styles.num}>
              {d.num}
            </Txt>
            <Txt v="tiny" color={on ? colors.white : d.short ? colors.destructiveInk : colors.ink3}>
              {d.hours}
            </Txt>
          </Press>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 5 },
  cell: { flex: 1, minWidth: 0, height: 64, borderRadius: radii.input, borderWidth: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  dim: { opacity: 0.85 },
  num: { fontSize: 16 },
});
