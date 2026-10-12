import { StyleSheet, TextInput, View } from 'react-native';

import { colors, fontFamily, radii } from '@/theme';

import { Icon } from './Icon';

export interface SearchFieldProps {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  testID?: string;
}

/** Search input: 44h, radius 12, border #D6DEE8, search icon at 13px (SPEC §6.2). */
export function SearchField({ value, onChange, placeholder, autoFocus, testID = 'search-field' }: SearchFieldProps) {
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
        style={styles.input}
        testID={testID}
      />
    </View>
  );
}

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
  },
});
