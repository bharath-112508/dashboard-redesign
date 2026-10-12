import { Image, StyleSheet, TextInput, View } from 'react-native';

import { colors, fontFamily, radii } from '@/theme';

import { Icon } from '../Icon';
import { Press } from '../Press';
import { Toggle } from '../Toggle';
import { Txt } from '../Txt';
import { DateInput } from './DateInput';
import { Field, inputStyles } from './Field';
import { FileInput } from './FileInput';
import { SelectInput } from './SelectInput';
import type { FieldBase, Option, PickedFile } from './types';

/** Select field 48h with a chevron (native <select> on web). */
export function SelectField({ value, options, onChange, testID, ...field }: FieldBase & { value: string; options: Option[]; onChange: (v: string) => void }) {
  return (
    <Field {...field}>
      <SelectInput label={field.label} value={value} options={options} onChange={onChange} invalid={!!field.error} testID={testID} />
    </Field>
  );
}

/** Date field (input type=date on web; ISO text on native). */
export function DateField({ value, onChange, testID, ...field }: FieldBase & { value: string; onChange: (iso: string) => void }) {
  return (
    <Field {...field}>
      <DateInput label={field.label} value={value} onChange={onChange} invalid={!!field.error} testID={testID} />
    </Field>
  );
}

/**
 * Pick field (SPEC §6.2): buttons 36h r10, selected ink with a check. Single (`value`
 * string) or multi (`values` array).
 */
export function PickField<V extends string>(
  props: FieldBase & { options: Option<V>[] } & ({ multi?: false; value: V | ''; onChange: (v: V) => void } | { multi: true; values: V[]; onChange: (v: V[]) => void }),
) {
  const { options, testID, label, required, optional, hint, error } = props;
  const isOn = (v: V) => (props.multi ? props.values.includes(v) : props.value === v);
  const tap = (v: V) => {
    if (props.multi) props.onChange(props.values.includes(v) ? props.values.filter((x) => x !== v) : [...props.values, v]);
    else props.onChange(v);
  };
  return (
    <Field label={label} required={required} optional={optional} hint={hint} error={error}>
      <View style={styles.picks} accessibilityRole={props.multi ? undefined : 'radiogroup'}>
        {options.map((o) => {
          const on = isOn(o.value);
          return (
            <Press
              key={o.value}
              label={o.label}
              a11yRole={props.multi ? 'checkbox' : 'radio'}
              checked={on}
              onPress={() => tap(o.value)}
              style={[styles.pick, on ? styles.pickOn : null]}
              testID={testID ? `${testID}-${o.value}` : undefined}
            >
              {on ? <Icon name="check" size={14} color={colors.white} /> : null}
              <Txt v="item" color={on ? colors.white : colors.ink2}>
                {o.label}
              </Txt>
            </Press>
          );
        })}
      </View>
    </Field>
  );
}

/** Toggle field: a card row with title, sub and a 44x26 switch; the whole card toggles. */
export function ToggleField({ title, sub, value, onChange, label = '', testID }: { title: string; sub?: string; value: boolean; onChange: (v: boolean) => void; label?: string; testID?: string }) {
  return (
    <Field label={label}>
      <Press label={title} a11yRole="switch" checked={value} onPress={() => onChange(!value)} style={styles.toggle} testID={testID}>
        <View style={styles.flex}>
          <Txt v="body" w={600}>
            {title}
          </Txt>
          {sub ? (
            <Txt v="sub" color={colors.ink3} style={styles.toggleSub}>
              {sub}
            </Txt>
          ) : null}
        </View>
        <Toggle on={value} />
      </Press>
    </Field>
  );
}

/** Hours + minutes pair (Time spent). An error shows "Add the time spent". */
export function HoursMinutesField({ h, m, onChange, testID = 'time', ...field }: FieldBase & { h: string; m: string; onChange: (h: string, m: string) => void }) {
  const box = (v: string, unit: string, set: (x: string) => void) => (
    <View style={styles.hmPart}>
      <TextInput
        value={v}
        onChangeText={(t) => set(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        accessibilityLabel={`${field.label} ${unit === 'h' ? 'hours' : 'minutes'}`}
        style={[inputStyles.box, styles.hmInput, field.error ? inputStyles.invalid : null]}
        testID={`${testID}-${unit === 'h' ? 'h' : 'm'}`}
      />
      <Txt v="label" w={400} color={colors.ink3} style={styles.hmUnit} pointerEvents="none">
        {unit}
      </Txt>
    </View>
  );
  return (
    <Field {...field}>
      <View style={styles.hm}>
        {box(h, 'h', (x) => onChange(x, m))}
        {box(m, 'min', (x) => onChange(h, x))}
      </View>
    </Field>
  );
}

/**
 * File field (SPEC §6.2): a dashed tile with a 44px preview square; image mode shows the
 * picked image (scaled to 200px on web).
 */
export function FileField({
  value,
  onPick,
  title = 'Choose a file',
  sub,
  image,
  accept,
  testID = 'file',
  ...field
}: FieldBase & { value: PickedFile | null; onPick: (f: PickedFile) => void; title?: string; sub?: string; image?: boolean; accept?: string }) {
  const t = value ? (image ? 'Image added' : value.n) : title;
  const s = value && !image ? value.size : (sub ?? '');
  return (
    <Field {...field}>
      <FileInput label={field.label || title} image={image} accept={accept} onPick={onPick} testID={testID}>
        <View style={styles.file}>
          <View style={styles.fileIcon}>
            {image && value?.uri ? <Image source={{ uri: value.uri }} style={styles.preview} /> : <Icon name="upload" size={18} color={colors.ink2} />}
          </View>
          <View style={styles.flex}>
            <Txt v="body" w={600} numberOfLines={1}>
              {t}
            </Txt>
            {s ? (
              <Txt v="meta" w={400} color={colors.ink3}>
                {s}
              </Txt>
            ) : null}
          </View>
        </View>
      </FileInput>
    </Field>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  picks: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pick: {
    height: 36,
    paddingHorizontal: 13,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: radii.tile,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  pickOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radii.input,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.ringCard,
  },
  toggleSub: { marginTop: 1 },
  hm: { flexDirection: 'row', gap: 8 },
  hmPart: { flex: 1, justifyContent: 'center' },
  hmInput: { paddingRight: 44, fontFamily: fontFamily[700], fontSize: 16 },
  hmUnit: { position: 'absolute', right: 14 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radii.input,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: colors.faint,
    backgroundColor: colors.surface,
  },
  fileIcon: { width: 44, height: 44, borderRadius: 11, backgroundColor: colors.track, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  preview: { width: 44, height: 44 },
});
