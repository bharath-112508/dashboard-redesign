import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Icon, Press, Screen, Txt } from '@/components';
import { staffPeople } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, push } from '@/nav/routes';
import { SCREEN_TITLES } from '@/nav/titles';
import { colors, radii, space } from '@/theme';

import { roleCounts, staffRoleOf } from './selectors';

/** S-USERS: role counts and the staff list (no clients) (M-41). */
export function UsersScreen() {
  const people = useAppState(staffPeople);
  const counts = useAppState(roleCounts);
  return (
    <Screen title={SCREEN_TITLES.users} gap={space.gap.list} contentStyle={styles.content} testID="screen-users">
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} testID="users-role-counts">
        {counts.map((r) => (
          <View key={r.role} style={styles.chip} accessible accessibilityLabel={`${r.role}: ${r.n}`}>
            <Txt v="caption" w={700}>
              {r.role}
            </Txt>
            <Txt v="caption" w={700} color={colors.ink3}>
              {String(r.n)}
            </Txt>
          </View>
        ))}
      </ScrollView>
      <View style={styles.card}>
        {people.map((p, i) => {
          const role = staffRoleOf(p);
          return (
            <Press
              key={p.name}
              label={`${p.name}, ${role}${p.active ? '' : ', inactive'}`}
              onPress={() => push(href.user(p.name))}
              scale={1}
              style={[styles.row, i > 0 && styles.divider]}
              testID={`user-row-${p.name}`}
            >
              <Avatar name={p.name} size={40} radius={20} />
              <View style={styles.flex}>
                <Txt v="rowTitle" w={800}>
                  {p.name}
                </Txt>
                <Txt v="caption" color={colors.ink3} numberOfLines={1}>{`${role} · ${p.email}`}</Txt>
              </View>
              {!p.active ? (
                <View style={styles.inactive}>
                  <Txt v="chip" w={800} color={colors.dangerInk}>
                    Inactive
                  </Txt>
                </View>
              ) : null}
              <Icon name="chevron-right" size={17} color={colors.muted} />
            </Press>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  chips: { gap: 6, padding: 2 },
  chip: {
    height: 30,
    paddingHorizontal: 12,
    borderRadius: 15,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  flex: { flex: 1, minWidth: 0 },
  inactive: { backgroundColor: colors.dangerSoft, paddingVertical: 3, paddingHorizontal: 8, borderRadius: radii.pill },
});
