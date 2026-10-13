import { useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';

import { colors, fontFamily, radii } from '@/theme';

import { Icon } from './Icon';

export interface SearchFieldProps {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  testID?: string;
}

/**
 * Search input: 44h, radius 12, border #D6DEE8, search icon at 13px (SPEC §6.2). The prototype has
 * `outline: 0`; on web the browser focus ring is removed and focus shows as a blue border instead.
 */
export function SearchField({ value, onChange, placeholder, autoFocus, testID = 'search-field' }: SearchFieldProps) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      <View style={styles.icon} pointerEvents="none">
        <Icon name="search" size={17} color={colors.ink3} />
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        accessibilityLabel={placeholder}
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, focused && styles.focused]}
        testID={testID}
      />
    </View>
  );
}

/** Web: no browser focus outline (the design uses outline: 0). */
export const noOutline = Platform.OS === 'web' ? ({ outlineWidth: 0 } as const) : {};

const styles = StyleSheet.create({
  wrap: { justifyContent: 'center' },
  icon: { position: 'absolute', left: 13, zIndex: 1 },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.input,
    paddingLeft: 40,
    paddingRight: 12,
    fontFamily: fontFamily[400],
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.surface,
    ...noOutline,
  },
  focused: { borderColor: colors.primary },
});
