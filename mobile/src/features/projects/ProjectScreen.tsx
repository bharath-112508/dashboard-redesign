/** S-PROJECT: overview card or maintenance hero, view switcher, and the selected view (M-25). */
import { StyleSheet, View } from 'react-native';

import { CompanyLogo, EmptyState, ProgressBar, Screen, SegmentedControl, Txt, type Segment } from '@/components';
import { capabilities, myRole, projectByName } from '@/data/selectors';
import { useActions, useAppState, type ProjectView } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { colors, radii } from '@/theme';

import { maintenanceVM } from './maintenance';
import { ProjectStatusButton } from './parts';
import { canSeeProject, currentView, overviewMeta } from './selectors';
import { ProjectViewBody } from './views';

const BUILD_SEGMENTS: Segment<ProjectView>[] = [
  { key: 'list', label: 'List', icon: 'list' },
  { key: 'board', label: 'Board', icon: 'square-kanban' },
  { key: 'tree', label: 'Epics', icon: 'git-fork' },
  { key: 'tl', label: 'Timeline', icon: 'chart-gantt' },
  { key: 'files', label: 'Files', icon: 'paperclip' },
];

const MAINT_SEGMENTS: Segment<ProjectView>[] = [
  { key: 'sup', label: 'Support', icon: 'life-buoy' },
  { key: 'rep', label: 'Report', icon: 'file-chart-column' },
  { key: 'list', label: 'List', icon: 'list' },
  { key: 'board', label: 'Board', icon: 'square-kanban' },
  { key: 'files', label: 'Files', icon: 'paperclip' },
];

export function ProjectScreen({ name }: { name: string }) {
  const project = useAppState((s) => projectByName(s, name));
  const visible = useAppState((s) => canSeeProject(s, name));
  const role = useAppState((s) => myRole(s) ?? 'dev');
  const view = useAppState((s) => currentView(s, name, project?.status === 'maint'));
  const { setProjectView } = useActions();

  if (!project || !visible) {
    return (
      <Screen title={name || 'Project'} testID="screen-project">
        <EmptyState icon="folder-check" text="This project is not available." />
      </Screen>
    );
  }

  const isMaint = project.status === 'maint';
  const canSet = capabilities(role).canSetProjectStatus;
  const openStatus = () => openSheet('project-status', { project: name });

  return (
    <Screen title={name} testID="screen-project" contentStyle={styles.content}>
      {isMaint ? (
        <MaintHero name={name} company={project.company} canSet={canSet} onStatus={openStatus} />
      ) : (
        <View style={styles.overview} testID="project-overview">
          <View style={styles.headRow}>
            <CompanyLogo company={project.company} size={44} radius={12} />
            <View style={styles.flex}>
              <Txt v="titleCard">{name}</Txt>
              <Txt v="meta" w={400} color={colors.ink3}>
                {project.company}
              </Txt>
            </View>
            <ProjectStatusButton status={project.status} canSet={canSet} onPress={openStatus} />
          </View>
          {project.status === 'active' || project.status === 'planned' ? (
            <View style={styles.progress}>
              <ProgressBar pct={project.pct} height={8} track={colors.primarySoft} style={styles.flex} label={`${project.pct}% done`} />
              <Txt v="body" w={800}>{`${project.pct}%`}</Txt>
            </View>
          ) : null}
          <OverviewMeta name={name} />
        </View>
      )}
      <SegmentedControl<ProjectView>
        variant="icon"
        label="Project view"
        value={view}
        onChange={(v) => setProjectView(name, v)}
        segments={isMaint ? MAINT_SEGMENTS : BUILD_SEGMENTS}
      />
      <ProjectViewBody key={view} view={view} project={name} />
    </Screen>
  );
}

function OverviewMeta({ name }: { name: string }) {
  const meta = useAppState((s) => overviewMeta(s, name));
  return (
    <Txt v="caption" w={600} color={colors.ink2} style={styles.meta}>
      {meta}
    </Txt>
  );
}

function MaintHero({ name, company, canSet, onStatus }: { name: string; company: string; canSet: boolean; onStatus: () => void }) {
  const vm = useAppState((s) => maintenanceVM(s, name));
  return (
    <View style={styles.hero} testID="project-hero">
      <View style={styles.headRow}>
        <View style={styles.heroLogo}>
          <CompanyLogo company={company} size={44} radius={12} />
        </View>
        <View style={styles.flex}>
          <Txt v="titleCard" color={colors.white}>
            {name}
          </Txt>
          <Txt v="meta" w={400} color={colors.tealOnDark}>
            {`${company} · Live since ${vm.liveSince}`}
          </Txt>
        </View>
        <ProjectStatusButton status="maint" canSet={canSet} onPress={onStatus} />
      </View>
      <View style={styles.running}>
        <View style={styles.halo}>
          <View style={styles.runDot} />
        </View>
        <Txt v="body" w={700} color={colors.white}>{`Running · ${vm.health.uptime} uptime`}</Txt>
      </View>
      <View style={styles.heroTiles}>
        <View style={styles.heroTile}>
          <Txt v="eyebrow" color={colors.tealOnDark} style={styles.tileLabel}>
            Support until
          </Txt>
          <Txt v="body" w={800} color={colors.white} style={styles.mt3}>
            {vm.until}
          </Txt>
        </View>
        <View style={styles.heroTile} testID="hero-open-requests">
          <Txt v="eyebrow" color={colors.tealOnDark} style={styles.tileLabel}>
            Open requests
          </Txt>
          <Txt v="body" w={800} color={colors.white} style={styles.mt3}>
            {String(vm.openCount)}
          </Txt>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 16 },
  flex: { flex: 1 },
  mt3: { marginTop: 3 },
  overview: { padding: 16, borderRadius: radii.hero, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  meta: { marginTop: 8 },
  hero: { padding: 16, borderRadius: radii.hero, backgroundColor: colors.tealDark, gap: 14 },
  heroLogo: { borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)' },
  running: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  halo: { width: 17, height: 17, borderRadius: 9, backgroundColor: 'rgba(127,209,180,0.25)', alignItems: 'center', justifyContent: 'center' },
  runDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.mint },
  heroTiles: { flexDirection: 'row', gap: 8 },
  heroTile: { flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.08)' },
  tileLabel: { fontSize: 11, letterSpacing: 0.66 },
});
