import { StyleSheet } from 'react-native';

import { colors } from '@/theme';

import { Card } from './Card';
import { Txt } from './Txt';

/** Empty state: card, padding 22/16, centred 13.5 text (SPEC §6.2 "Empty"). */
export function EmptyBlock({ text, testID }: { text: string; testID?: string }) {
  return (
    <Card style={styles.card} testID={testID}>
      <Txt v="item" w={400} color={colors.ink3} align="center">
        {text}
      </Txt>
    </Card>
  );
}

const styles = StyleSheet.create({ card: { paddingVertical: 22, paddingHorizontal: 16 } });
