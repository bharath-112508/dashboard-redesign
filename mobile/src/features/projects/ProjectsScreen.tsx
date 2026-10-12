import { useMemo, useState } from 'react';

import { Block, FilterChips, ProjectTile, Row, Rows, Screen, SearchField, Segmented } from '@/components';
import { PROJECT_STATE } from '@/data/constants';
import { myPerm, projVis } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, openSheet, push } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { deadlineMeta, filterProjects, projectRowSub, stateChips, type KindFilter, type StateFilter } from './derive';

/**
 * S5-PROJECTS (staff): search, Client/Internal segment, status chips with counts and
 * project rows (V-40). "+" New project with `projects.create` (V-41).
 */
export function ProjectsScreen() {
  const all = useAppState(projVis);
  const canNew = useAppState((s) => myPerm(s, 'projects.create'));
  const root = useRootActions();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [st, setSt] = useState<StateFilter>('all');
  const chips = useMemo(() => stateChips(all), [all]);
  const L = useMemo(() => filterProjects(all, { q, kind, st }), [all, q, kind, st]);
  const actions = canNew
    ? [{ icon: 'plus' as const, label: 'New project', onPress: () => openSheet('new-project'), testID: 'header-new-project' }, ...root]
    : root;

  return (
    <Screen title="Projects" actions={actions} testID="screen-projects">
      <SearchField value={q} onChange={setQ} placeholder="Search projects" testID="projects-search" />
      <Segmented
        options={[
          { value: 'all', label: 'All' },
          { value: 'client', label: 'Client' },
          { value: 'internal', label: 'Internal' },
        ]}
        value={kind}
        onChange={setKind}
        testID="projects-kind"
      />
      <FilterChips options={chips} value={st} onChange={setSt} testID="projects-st" />
      <Block title={`${L.length} project${L.length === 1 ? '' : 's'}`} testID="projects-list">
        <Rows empty="No projects match these filters." testID="projects-rows">
          {L.map((p) => {
            const s = PROJECT_STATE[p.state];
            const dl = deadlineMeta(p);
            return (
              <Row
                key={p.id}
                lead={<ProjectTile id={p.id} />}
                title={p.name}
                sub={projectRowSub(p)}
                badge={{ label: s.label, tone: s.tone }}
                bar={p.state === 'maint' ? undefined : { pct: p.pct, color: p.state === 'done' ? colors.green : colors.primary, label: `${p.pct}%` }}
                meta={[
                  dl ? { icon: 'flag', text: dl.text, color: dl.late ? colors.danger : colors.ink3, bold: dl.late } : null,
                  { icon: 'users', text: String(p.team.length) },
                ]}
                onPress={() => push(href.project(p.id))}
                testID={`project-row-${p.id}`}
              />
            );
          })}
        </Rows>
      </Block>
    </Screen>
  );
}
