/** S-PSS: project status sheet (staffAll, M-28). Maintenance without a plan opens S-PLAN. */
import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Icon, Press, showToast, Txt } from '@/components';
import { PROJECT_STATUS_OPTIONS } from '@/data/constants';
import { capabilities, myRole, projectByName } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { ProjectStatus } from '@/data/types';
import { closeSheet, sheetHref } from '@/nav/routes';
import { colors } from '@/theme';

export function ProjectStatusSheet() {
  const { project = '' } = useLocalSearchParams<{ project?: string }>();
  const p = useAppState((s) => projectByName(s, project));
  const role = useAppState(myRole);
  const { setProjectStatus } = useActions();
  const allowed = !!role && capabilities(role).canSetProjectStatus;

  const pick = (k: ProjectStatus) => {
    if (!p) return;
    if (k === 'maint' && !p.plan) {
      router.replace(sheetHref('support-plan', { project }));
      return;
    }
    const msg = setProjectStatus(project, k);
    closeSheet();
    showToast(msg);
  };

  return (
    <BottomSheet title="Project status" showClose={false} testID="sheet-project-status">
      <View style={styles.list}>
        {!p || !allowed ? (
          <Txt v="bodySm" w={400} color={colors.ink3}>
            Only project managers and admins can change the project status.
          </Txt>
        ) : (
          PROJECT_STATUS_OPTIONS.map((o) => {
            const on = p.status === o.key;
            return (
              <Press
                key={o.key}
                label={`${o.label}: ${o.desc}`}
                a11yRole="radio"
                checked={on}
                onPress={() => pick(o.key)}
                scale={0.98}
                style={[styles.row, on ? styles.rowOn : styles.rowOff]}
                testID={`status-option-${o.key}`}
              >
                <Icon name={o.icon} size={20} color={colors.primaryInk} />
                <View style={styles.flex}>
                  <Txt v="rowTitle" w={800}>
                    {o.label}
                  </Txt>
                  <Txt v="caption" color={colors.ink3}>
                    {o.desc}
                  </Txt>
                </View>
                {on ? <Icon name="check" size={18} color={colors.primaryInk} strokeWidth={2.4} /> : null}
              </Press>
            );
          })
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  list: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 18, borderWidth: 1 },
  rowOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  rowOff: { backgroundColor: colors.surface, borderColor: colors.line },
});
