import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import { fmtL } from '@/data/format';
import { colors } from '@/theme';

import { Txt } from '../Txt';
import { inputStyles } from './Field';
import type { DateInputProps } from './types';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Date control (native): ISO text with a readable echo ("Sat 17 Oct"). Web: DateInput.web.tsx. */
export function DateInput({ label, value, onChange, invalid, testID }: DateInputProps) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <View style={{ gap: 4 }}>
      <TextInput
        value={text}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={colors.ink3}
        accessibilityLabel={label}
        keyboardType="numbers-and-punctuation"
        autoCapitalize="none"
        maxLength={10}
        style={[inputStyles.box, invalid ? inputStyles.invalid : null]}
        testID={testID}
        onChangeText={(t) => {
          setText(t);
          if (ISO.test(t)) onChange(t);
          else if (!t) onChange('');
        }}
      />
      {ISO.test(text) ? (
        <Txt v="meta" w={400} color={colors.ink3}>
          {`${fmtL(text)} ${text.slice(0, 4)}`}
        </Txt>
      ) : null}
    </View>
  );
}
