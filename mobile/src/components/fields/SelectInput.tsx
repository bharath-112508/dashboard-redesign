import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radii } from '@/theme';

import { Icon } from '../Icon';
import { Press } from '../Press';
import { Txt } from '../Txt';
import { inputStyles } from './Field';
import type { SelectInputProps } from './types';

/** Select control (native): a 48h field that opens an option list. Web: SelectInput.web.tsx. */
export function SelectInput({ label, value, options, onChange, invalid, testID }: SelectInputProps) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Press label={`${label}: ${current?.label ?? ''}`} onPress={() => setOpen(true)} style={[inputStyles.box, styles.row, invalid && inputStyles.invalid]} testID={testID}>
        <Txt v="input" numberOfLines={1} style={styles.flex}>
          {current?.label ?? ''}
        </Txt>
        <Icon name="chevron-down" size={16} color={colors.ink2} />
      </Press>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <Txt v="title" style={styles.title}>
            {label}
          </Txt>
          <ScrollView style={styles.list}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <Press
                  key={o.value}
                  label={o.label}
                  a11yRole="radio"
                  checked={on}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Txt v="rowTitle" w={on ? 700 : 400} style={styles.flex}>
                    {o.label}
                  </Txt>
                  {on ? <Icon name="check" size={18} color={colors.primaryInk} /> : null}
                </Press>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  flex: { flex: 1 },
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.bg,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingTop: 18,
    paddingHorizontal: 12,
  },
  title: { paddingHorizontal: 8, paddingBottom: 8 },
  list: { maxHeight: 420 },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 12, borderRadius: 12 },
  optionOn: { backgroundColor: colors.primarySoft },
});
