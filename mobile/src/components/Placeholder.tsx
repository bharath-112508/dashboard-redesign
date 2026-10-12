import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { BottomSheet } from './BottomSheet';
import { Block } from './Card';
import { Screen } from './Screen';
import { TextBlock } from './TextBlock';
import { Txt } from './Txt';
import type { HeaderAction } from './Header';

export interface PlaceholderProps {
  /** e.g. "S5-SEARCH" */
  spec: string;
  /** owning package ("W1") */
  owner: string;
  title: string;
  sub?: string;
  actions?: HeaderAction[];
  /** route params to show (debugging aid) */
  params?: Record<string, string | string[] | undefined>;
  /** test id suffix: screen-<id> */
  id: string;
  /** extra blocks under the placeholder note */
  children?: ReactNode;
}

function ParamList({ params }: { params?: PlaceholderProps['params'] }) {
  const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined && v !== '');
  if (!entries.length) return null;
  return (
    <View style={styles.params}>
      {entries.map(([k, v]) => (
        <Txt key={k} v="meta" color={colors.ink3} testID={`param-${k}`}>
          {`${k}: ${Array.isArray(v) ? v.join(',') : v}`}
        </Txt>
      ))}
    </View>
  );
}

/**
 * Stand-in for a v5 screen that a feature package (W1–W4) replaces. It already has the
 * right header, guard and tab bar, so navigation works end to end.
 */
export function PlaceholderScreen({ spec, owner, title, sub, actions, params, id, children }: PlaceholderProps) {
  return (
    <Screen title={title} sub={sub} actions={actions} testID={`screen-${id}`}>
      <Block title={spec} sub={`Placeholder · built by ${owner}`}>
        <TextBlock tone="info" text={`${spec} is built by package ${owner}. See mobile-spec-v5/SPEC.md.`} />
      </Block>
      <ParamList params={params} />
      {children}
    </Screen>
  );
}

/** Stand-in for a URL sheet a feature package replaces. */
export function PlaceholderSheet({ spec, owner, title, sub, params, id, children }: Omit<PlaceholderProps, 'actions'>) {
  return (
    <BottomSheet title={title} sub={sub} testID={`sheet-${id}`}>
      <TextBlock tone="info" text={`${spec} is built by package ${owner}. See mobile-spec-v5/SPEC.md §5.`} />
      <ParamList params={params} />
      {children}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({ params: { gap: 2, paddingHorizontal: 4 } });
