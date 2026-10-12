import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Txt } from './Txt';

export type TextTone = 'plain' | 'note' | 'info' | 'bad' | 'good';

const T: Record<TextTone, { bg: string; fg: string; ring?: string; icon?: IconName }> = {
  plain: { bg: colors.surface, fg: colors.ink, ring: colors.ringCard },
  note: { bg: colors.amberSoft, fg: colors.noteInk, icon: 'info' },
  info: { bg: colors.primarySoft, fg: colors.primaryInk, icon: 'info' },
  bad: { bg: colors.redSoft, fg: colors.dangerInk, icon: 'triangle-alert' },
  good: { bg: colors.greenSoft, fg: colors.greenInk, icon: 'circle-check' },
};

/**
 * Text block (SPEC §6.2): r16 card, 14/1.5 pre-wrap; tones plain (white + ring), note
 * (amber + info), info (blue + info), bad (red + triangle-alert), good (green +
 * circle-check). Error lines in forms use `bad`.
 */
export function TextBlock({ text, tone = 'plain', testID }: { text: string; tone?: TextTone; testID?: string }) {
  const t = T[tone];
  return (
    <View style={[styles.box, { backgroundColor: t.bg }, t.ring ? { borderWidth: 1, borderColor: t.ring } : null]} testID={testID}>
      {t.icon ? (
        <View style={styles.icon}>
          <Icon name={t.icon} size={17} color={t.fg} />
        </View>
      ) : null}
      <Txt v="body" color={t.fg} style={styles.text} accessibilityRole={tone === 'bad' ? 'alert' : undefined}>
        {text}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { borderRadius: radii.card, paddingVertical: 13, paddingHorizontal: 14, flexDirection: 'row', gap: 10 },
  icon: { marginTop: 1 },
  text: { flex: 1, minWidth: 0 },
});
