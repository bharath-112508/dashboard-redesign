import type { Href } from 'expo-router';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { BottomSheet } from './BottomSheet';
import { Card, ListCard, ListRow } from './Card';
import type { HeaderAction } from './Headers';
import { Screen } from './Screen';
import { Txt } from './Txt';

export interface PlaceholderLink {
  label: string;
  href: Href;
}

export interface PlaceholderProps {
  /** screen id from SPEC.md, e.g. "S-HOME" */
  screen: string;
  title: string;
  /** owning package, e.g. "P1" */
  owner: 'P1' | 'P2' | 'P3' | 'P4';
  /** route file the owner replaces */
  file: string;
  header?: 'large' | 'small';
  action?: HeaderAction;
  noTabBar?: boolean;
  /** params the route received (shown for checking) */
  params?: Record<string, unknown>;
  /** quick links to reachable routes */
  links?: PlaceholderLink[];
  testID: string;
}

/**
 * Stand-in for a screen a feature package builds. Shows which package owns it, the file
 * to replace, and the params it received. P1–P4 replace the whole route file body.
 */
export function Placeholder({ screen, title, owner, file, header = 'small', action, noTabBar, params, links, testID }: PlaceholderProps) {
  const p = params && Object.keys(params).length ? JSON.stringify(params) : '';
  return (
    <Screen title={title} header={header} action={action} noTabBar={noTabBar} testID={testID}>
      <Card style={styles.card}>
        <Txt v="eyebrow" color={colors.ink3}>{`Placeholder · ${screen}`}</Txt>
        <Txt v="titleMd" testID="placeholder-title">
          {title}
        </Txt>
        <Txt v="caption" color={colors.ink3}>{`Built by ${owner}. Replace ${file}.`}</Txt>
        {p ? (
          <Txt v="small" color={colors.ink2} testID="placeholder-params">
            {`Params: ${p}`}
          </Txt>
        ) : null}
      </Card>
      {links?.length ? (
        <ListCard>
          {links.map((l, i) => (
            <ListRow key={l.label} title={l.label} first={i === 0} onPress={() => router.push(l.href)} testID={`link-${l.label}`} />
          ))}
        </ListCard>
      ) : null}
    </Screen>
  );
}

export interface PlaceholderSheetProps {
  screen: string;
  title: string;
  owner: 'P1' | 'P2' | 'P3' | 'P4';
  file: string;
  params?: Record<string, unknown>;
  testID: string;
}

/** Stand-in for a bottom-sheet route. */
export function PlaceholderSheet({ screen, title, owner, file, params, testID }: PlaceholderSheetProps) {
  const p = params && Object.keys(params).length ? JSON.stringify(params) : '';
  return (
    <BottomSheet title={title} subtitle={`Placeholder · ${screen}`} icon="pencil-line" testID={testID}>
      <View style={styles.card}>
        <Txt v="caption" color={colors.ink3}>{`Built by ${owner}. Replace ${file}.`}</Txt>
        {p ? (
          <Txt v="small" color={colors.ink2} testID="placeholder-params">
            {`Params: ${p}`}
          </Txt>
        ) : null}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6 },
});
