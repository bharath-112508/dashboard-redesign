/** S-PROJECTS: filters, company groups and project cards (M-24). */
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Card, CompanyLogo, Dot, EmptyState, Icon, ProgressBar, Screen, SegmentedControl, Txt } from '@/components';
import { PROJECT_STATUS } from '@/data/constants';
import { plural } from '@/data/format';
import { myRole } from '@/data/selectors';
import { useActions, useAppState, type ProjectFilter } from '@/data/store';
import { toProject } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';
import { colors, motion, radii } from '@/theme';

import { projectsTab, type ProjectCardVM } from './selectors';

export function ProjectsScreen({ pushed }: { pushed?: boolean }) {
  const role = useAppState((s) => myRole(s) ?? 'dev');
  const vm = useAppState(projectsTab);
  const { setUi } = useActions();
  return (
    <Screen
      title={pushed ? 'Projects' : tabTitle('projects', role)}
      header={pushed ? 'small' : 'large'}
      testID={pushed ? 'screen-stack-projects' : 'screen-projects'}
      gap={18}
    >
      <SegmentedControl<ProjectFilter>
        variant="pill"
        label="Project filter"
        value={vm.filter}
        onChange={(k) => setUi({ projectFilter: k })}
        segments={[
          { key: 'active', label: 'Active', count: vm.counts.active },
          { key: 'maint', label: 'Maintenance', count: vm.counts.maint },
          { key: 'done', label: 'Completed', count: vm.counts.done },
        ]}
      />
      {!vm.groups.length ? <EmptyState icon="folder-check" text="No projects here." bare /> : null}
      {vm.groups.map((g, gi) => (
        <Animated.View key={g.company} style={[styles.group, motion.fadeUp(gi, 0.05, 0.06)]} testID={`company-${g.company}`}>
          <View style={styles.coHead}>
            <CompanyLogo company={g.company} size={28} radius={8} />
            <Txt v="titleSm" w={800}>
              {g.company}
            </Txt>
            <Txt v="meta" w={700} color={colors.ink3}>
              {plural(g.projects.length, 'project')}
            </Txt>
          </View>
          <View style={styles.cards}>
            {g.projects.map((p) => (
              <ProjectCard key={p.name} p={p} />
            ))}
          </View>
        </Animated.View>
      ))}
    </Screen>
  );
}

function ProjectCard({ p }: { p: ProjectCardVM }) {
  const st = PROJECT_STATUS[p.status];
  return (
    <Card onPress={() => toProject(p.name)} label={`${p.name}, ${st.label}`} testID={`project-card-${p.name}`}>
      <View style={styles.head}>
        <Txt v="titleSm" style={styles.flex} numberOfLines={1}>
          {p.name}
        </Txt>
        <View style={[styles.pill, { backgroundColor: st.soft }]}>
          <Dot color={st.dot} size={6} />
          <Txt v="small" w={700} color={st.ink}>
            {st.label}
          </Txt>
        </View>
      </View>
      <Txt v="caption" color={colors.ink3} style={styles.meta}>
        {p.meta}
      </Txt>
      {p.showBar ? (
        <View style={styles.bar}>
          <ProgressBar pct={p.pct} height={7} track={colors.primarySoft} style={styles.flex} label={`${p.pct}% done`} />
          <Txt v="meta" w={800}>{`${p.pct}%`}</Txt>
        </View>
      ) : null}
      {p.support ? (
        <View style={styles.sup}>
          <View style={styles.supHead}>
            <Icon name="wrench" size={14} color={colors.tealInk} />
            <Txt v="meta" w={700} color={colors.tealInk}>
              {p.support.until}
            </Txt>
          </View>
          {p.support.hasHours ? <ProgressBar pct={p.support.pct} height={6} color={colors.teal} track={colors.surface} /> : null}
          <Txt v="small" color={colors.tealInk}>
            {p.support.hours}
          </Txt>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  group: { gap: 9 },
  coHead: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 4 },
  cards: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 9, height: 22, borderRadius: radii.pill },
  meta: { marginTop: 4 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  sup: { gap: 6, marginTop: 10, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.tealSoft },
  supHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
