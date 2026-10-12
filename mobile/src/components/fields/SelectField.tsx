import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radii } from '@/theme';

import { Icon } from '../Icon';
import { Press } from '../Press';
import { Txt } from '../Txt';
import { inputStyles } from './Field';
import type { SelectFieldProps } from './types';

/**
 * Select (native): a field that opens an option list sheet. The web build uses a real
 * <select> (SelectField.web.tsx) like the prototype.
 */
export function SelectField({ label, value, options, onChange, highlight, testID }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Press
        label={`${label}: ${current?.label ?? ''}`}
        onPress={() => setOpen(true)}
        scale={1}
        style={[inputStyles.box, styles.row, highlight && inputStyles.focus]}
        testID={testID}
      >
        <Txt v="bodyLg" style={{ flex: 1 }} numberOfLines={1}>
          {current?.label ?? ''}
        </Txt>
        <Icon name="chevron-down" size={18} color={colors.muted} />
      </Press>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <Txt v="sheetTitle" style={styles.title}>
            {label}
          </Txt>
          <ScrollView style={{ maxHeight: 420 }}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <Press
                  key={o.value}
                  label={o.label}
                  a11yRole="radio"
                  checked={on}
                  scale={1}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  style={[styles.option, on && styles.optionOn]}
                >
                  <Txt v="bodyLg" w={on ? 700 : 400} style={{ flex: 1 }}>
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
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.overlay },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    paddingTop: 18,
    paddingHorizontal: 12,
  },
  title: { paddingHorizontal: 8, paddingBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', minHeight: 48, paddingHorizontal: 12, borderRadius: 12 },
  optionOn: { backgroundColor: colors.primarySoft },
});
