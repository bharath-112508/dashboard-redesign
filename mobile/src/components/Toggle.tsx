import { StyleSheet, View } from 'react-native';

import { colors, shadows } from '@/theme';

import { Press } from './Press';

/**
 * Switch 44x26 (SPEC §6.2). Without `onToggle` it only draws (rows and toggle fields
 * make the whole row pressable).
 */
export function Toggle({ on, onToggle, label, testID }: { on: boolean; onToggle?: () => void; label?: string; testID?: string }) {
  const body = (
    <View style={[styles.track, { backgroundColor: on ? colors.primary : colors.lineInput }]}>
      <View style={[styles.knob, { left: on ? 21 : 3 }]} />
    </View>
  );
  if (!onToggle) return body;
  return (
    <Press label={label ?? 'Toggle'} a11yRole="switch" checked={on} onPress={onToggle} testID={testID} flat>
      {body}
    </Press>
  );
}

const styles = StyleSheet.create({
  track: { width: 44, height: 26, borderRadius: 13 },
  knob: { position: 'absolute', top: 3, width: 20, height: 20, borderRadius: 10, backgroundColor: colors.white, ...shadows.knob },
});
