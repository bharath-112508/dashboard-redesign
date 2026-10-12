import { StyleSheet, View } from 'react-native';

import { Card, CompanyLogo, EmptyState, Icon, Screen, SegmentedControl, Txt } from '@/components';
import { useActions, useAppState } from '@/data/store';
import { href, push } from '@/nav/routes';
import { SCREEN_TITLES } from '@/nav/titles';
import { colors, space } from '@/theme';

import { companyRows } from './selectors';

type Tab = 'active' | 'archived';

/** S-COMPANIES: Active / Archived tabs and company rows (M-40). */
export function CompaniesScreen() {
  const archived = useAppState((s) => s.ui.showArchived);
  const rows = useAppState((s) => companyRows(s, archived));
  const { setUi } = useActions();
  return (
    <Screen title={SCREEN_TITLES.companies} gap={space.gap.list} contentStyle={styles.content} testID="screen-companies">
      <SegmentedControl<Tab>
        variant="pill"
        label="Companies"
        value={archived ? 'archived' : 'active'}
        onChange={(k) => setUi({ showArchived: k === 'archived' })}
        segments={[
          { key: 'active', label: 'Active', icon: 'building-2' },
          { key: 'archived', label: 'Archived', icon: 'archive' },
        ]}
      />
      {rows.length ? (
        rows.map((c) => (
          <Card key={c.name} onPress={() => push(href.company(c.name))} label={`${c.name}, ${c.meta}`} style={styles.row} testID={`company-row-${c.name}`}>
            <CompanyLogo company={c.name} size={44} radius={12} />
            <View style={styles.text}>
              <Txt v="cardTitle" w={800}>
                {c.name}
              </Txt>
              <Txt v="caption" color={colors.ink3}>
                {c.meta}
              </Txt>
            </View>
            <Icon name="chevron-right" size={18} color={colors.muted} />
          </Card>
        ))
      ) : (
        <EmptyState icon="archive" text={archived ? 'No archived companies.' : 'No active companies.'} bare />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, minWidth: 0 },
});
