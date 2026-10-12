import { StyleSheet, View } from 'react-native';

import { Avatar, Card, EmptyState, Eyebrow, Icon, Press, Screen, Txt } from '@/components';
import { showToast } from '@/components/Toast';
import { ROLE_ACCESS, STAFF_ROLES } from '@/data/constants';
import { personByName } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { colors, radii, space } from '@/theme';

import { staffRoleOf } from './selectors';

/** S-USER: avatar, role pills, access text, deactivate/reactivate (M-41). */
export function UserScreen({ name }: { name: string }) {
  const person = useAppState((s) => personByName(s, name));
  const { setUserRole, toggleUserActive } = useActions();

  if (!person || person.client) {
    return (
      <Screen title={name} testID="screen-user">
        <EmptyState icon="user-round" text="This user no longer exists." />
      </Screen>
    );
  }
  const current = staffRoleOf(person);
  return (
    <Screen title={person.name} gap={space.gap.detail} contentStyle={styles.content} testID="screen-user">
      <Card pad={20} style={styles.head}>
        <Avatar name={person.name} size={72} radius={36} />
        <Txt v="titleCard">{person.name}</Txt>
        <Txt v="meta" w={400} color={colors.ink3}>
          {person.email}
        </Txt>
      </Card>

      <Eyebrow style={styles.eyebrow}>Role</Eyebrow>
      <View style={styles.grid} accessibilityRole="radiogroup" accessibilityLabel="Role">
        {STAFF_ROLES.map((r) => {
          const on = r === current;
          return (
            <Press
              key={r}
              label={r}
              a11yRole="radio"
              checked={on}
              onPress={() => {
                if (!on) showToast(setUserRole(person.name, r));
              }}
              scale={0.97}
              style={[styles.role, on ? styles.roleOn : styles.roleOff]}
              testID={`user-role-${r}`}
            >
              <Txt v="bodySm" w={700} color={on ? colors.white : colors.ink}>
                {r}
              </Txt>
            </Press>
          );
        })}
      </View>

      <Card style={styles.access}>
        <Icon name="shield-check" size={19} color={colors.violetInk} />
        <View style={styles.flex}>
          <Txt v="small" w={700} color={colors.ink3}>
            Can access
          </Txt>
          <Txt v="body" w={600} testID="user-access">
            {ROLE_ACCESS[current]}
          </Txt>
        </View>
      </Card>

      <Press
        label={person.active ? 'Deactivate account' : 'Reactivate account'}
        onPress={() => showToast(toggleUserActive(person.name))}
        scale={0.97}
        style={styles.actBtn}
        testID="user-active"
      >
        <Txt v="bodyLg" w={700} color={person.active ? colors.danger : colors.primaryInk}>
          {person.active ? 'Deactivate account' : 'Reactivate account'}
        </Txt>
      </Press>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  head: { alignItems: 'center', gap: 8 },
  eyebrow: { paddingHorizontal: 4 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  role: { width: '48.5%', flexGrow: 1, height: 46, borderRadius: 23, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  roleOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  roleOff: { backgroundColor: colors.surface, borderColor: colors.line },
  access: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  flex: { flex: 1, minWidth: 0, gap: 2 },
  actBtn: {
    height: 48,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
