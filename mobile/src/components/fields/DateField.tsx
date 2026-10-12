import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { dow, sh } from '@/data/format';
import { colors } from '@/theme';

import { Txt } from '../Txt';
import { TextField } from './TextField';
import type { DateFieldProps } from './types';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Date input (native): ISO text "YYYY-MM-DD" with a readable echo ("Sat 17 Oct").
 * The web build uses <input type="date"> (DateField.web.tsx).
 */
export function DateField({ label, value, onChange, testID }: DateFieldProps) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = ISO.test(text) && !Number.isNaN(new Date(`${text}T12:00:00Z`).getTime());
  return (
    <View style={styles.wrap}>
      <TextField
        label={label}
        value={text}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={10}
        testID={testID}
        onChangeText={(t) => {
          setText(t);
          if (ISO.test(t)) onChange(t);
          else if (!t) onChange('');
        }}
      />
      {valid ? (
        <Txt v="small" w={400} color={colors.ink3}>
          {`${dow(text)} ${sh(text)} ${text.slice(0, 4)}`}
        </Txt>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({ wrap: { gap: 4 } });
