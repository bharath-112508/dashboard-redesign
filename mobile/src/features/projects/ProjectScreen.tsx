import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { EmptyBlock, Hero, ProjectTile, Screen, Segmented, TextTile, type HeroProps } from '@/components';
import { TODAY } from '@/data/clock';
import { PROJECT_STATE } from '@/data/constants';
import { fmt } from '@/data/format';
import { canSeeProject, canSetProjectStatus, isClient, myPerm, myRole, project, questionsOf, ticketsOf, type ProjectView } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { ProjectBugsTab } from '@/features/client/ProjectBugsTab';
import { ProjectQuestionsTab } from '@/features/client/ProjectQuestionsTab';
import { ProjectDevopsTab } from '@/features/devops/ProjectDevopsTab';
import { openSheet, type ProjectTab } from '@/nav/routes';
import { colors, space } from '@/theme';

import { CREATE_TABS, initialTab, projectTabs, TAB_LABEL, type ListFilter } from './derive';
import { BoardTab } from './tabs/BoardTab';
import { FilesTab } from './tabs/FilesTab';
import { ListTab } from './tabs/ListTab';
import { OverviewTab } from './tabs/OverviewTab';
import { SprintsTab } from './tabs/SprintsTab';
import { SupportTab } from './tabs/SupportTab';
import { TeamTab } from './tabs/TeamTab';
import { TimelineTab } from './tabs/TimelineTab';
import { TimeTab } from './tabs/TimeTab';
import type { Jump } from './tabs/types';

const ON_DARK_PILL = 'rgba(255,255,255,0.14)';

/**
 * S5-PROJECT: hero (building or maintenance), the sideways tab segment and the tab body
 * (V-43). Tab, list filter and board epic are screen state; `?tab=` sets the first tab.
 * DevOps, Questions and Bugs bodies are W4 embeds.
 */
export function ProjectScreen({ id, tab: tabParam }: { id: string; tab?: string }) {
  const p = useAppState((s) => project(s, id));
  const client = useAppState(isClient);
  const visible = useAppState((s) => !isClient(s) || canSeeProject(s, id));
  const role = useAppState(myRole);
  const canCreate = useAppState((s) => myPerm(s, 'tickets.create'));
  const tickets = useAppState((s) => ticketsOf(s, id));
  const qOpen = useAppState((s) => questionsOf(s, id).filter((q) => !q.answer).length);
  const [chosen, setChosen] = useState<string | null>(tabParam ?? null);
  const [listSt, setListSt] = useState<ListFilter>('open');
  const [boardEpic, setBoardEpic] = useState('all');

  if (!p || !visible) {
    return (
      <Screen title="Project" testID="screen-project">
        <EmptyBlock text="Project not found." testID="project-not-found" />
      </Screen>
    );
  }

  const tabs = projectTabs(p, client);
  const tab = initialTab(p, client, chosen ?? undefined);
  const jump: Jump = (t, opts) => {
    if (opts?.st) setListSt(opts.st);
    if (opts?.epic) setBoardEpic(opts.epic);
    setChosen(t);
  };
  const actions =
    !client && canCreate && CREATE_TABS.includes(tab)
      ? [{ icon: 'plus' as const, label: 'Create ticket', onPress: () => openSheet('new-ticket', { pid: p.id }), testID: 'header-create-ticket' }]
      : [];
  const canSet = canSetProjectStatus(role);
  const open = tickets.filter((t) => t.st !== 'done').length;
  const reqOpen = tickets.filter((t) => t.support && t.st !== 'done').length;

  return (
    <Screen title={p.name} sub={p.co} actions={actions} testID="screen-project">
      <Hero {...heroProps(p, { canSet, open, reqOpen })} testID="project-hero" />
      <Segmented
        options={tabs.map((t) => ({ value: t, label: TAB_LABEL[t], count: t === 'questions' && qOpen ? qOpen : undefined }))}
        value={tab}
        onChange={(t) => setChosen(t)}
        testID="project-tab"
      />
      <View style={styles.body} testID={`project-body-${tab}`}>
        <TabBody tab={tab} p={p} client={client} jump={jump} listSt={listSt} setListSt={setListSt} boardEpic={boardEpic} setBoardEpic={setBoardEpic} />
      </View>
    </Screen>
  );
}

function heroProps(p: ProjectView, o: { canSet: boolean; open: number; reqOpen: number }): HeroProps {
  const s = PROJECT_STATE[p.state];
  const onStatus = o.canSet ? () => openSheet('project-status', { id: p.id }) : undefined;
  if (p.state === 'maint') {
    return {
      variant: 'teal',
      lead: <ProjectTile id={p.id} size={46} radius={13} />,
      eyebrow: `Maintenance · ${p.co}`,
      title: p.name,
      sub: `Live since ${fmt(p.due)}`,
      status: { label: s.label, bg: ON_DARK_PILL, ink: colors.white, dot: colors.toastIcon },
      onStatus,
      chips: [
        { text: 'Up · 99.98% uptime', dot: colors.uptime },
        { text: `Support until ${fmt(p.sup?.until)}`, dot: colors.toastIcon },
        { text: `${o.reqOpen} open request${o.reqOpen === 1 ? '' : 's'}`, dot: o.reqOpen ? colors.amberDot : colors.toastIcon },
      ],
    };
  }
  const late = p.state !== 'done' && !!p.due && p.due < TODAY;
  const chip = (text: string, dot: string) => ({ text, dot, bg: colors.bg, color: colors.ink2 });
  return {
    variant: 'white',
    lead: p.kind === 'client' ? <ProjectTile id={p.id} size={46} radius={13} /> : <TextTile text="IN" bg={colors.violetSoft} fg={colors.violetInk} size={46} radius={13} />,
    eyebrow: p.kind === 'client' ? p.co : `Internal · ${p.area ?? ''}`,
    title: p.name,
    sub: p.desc || undefined,
    status: { label: s.label, tone: s.tone },
    onStatus,
    chips: [
      chip(`${o.open} open tickets`, colors.primary),
      ...(p.due ? [chip(`Deadline ${fmt(p.due)}`, late ? colors.danger : colors.faint)] : []),
      chip(`${p.team.length} people`, colors.violet),
    ],
    bar: { pct: p.pct, color: p.state === 'done' ? colors.green : colors.primary, label: `${p.pct}% done` },
  };
}

interface BodyProps {
  tab: ProjectTab;
  p: ProjectView;
  client: boolean;
  jump: Jump;
  listSt: ListFilter;
  setListSt: (v: ListFilter) => void;
  boardEpic: string;
  setBoardEpic: (v: string) => void;
}

function TabBody({ tab, p, client, jump, listSt, setListSt, boardEpic, setBoardEpic }: BodyProps) {
  switch (tab) {
    case 'overview':
      return <OverviewTab p={p} client={client} jump={jump} />;
    case 'support':
      return <SupportTab p={p} />;
    case 'board':
      return <BoardTab p={p} client={client} epic={boardEpic} setEpic={setBoardEpic} />;
    case 'list':
      return <ListTab p={p} st={listSt} setSt={setListSt} />;
    case 'sprints':
      return <SprintsTab p={p} />;
    case 'timeline':
      return <TimelineTab p={p} jump={jump} />;
    case 'files':
      return <FilesTab p={p} />;
    case 'time':
      return <TimeTab p={p} />;
    case 'team':
      return <TeamTab p={p} />;
    case 'devops':
      return <ProjectDevopsTab projectId={p.id} />;
    case 'questions':
      return <ProjectQuestionsTab projectId={p.id} />;
    case 'bugs':
      return <ProjectBugsTab projectId={p.id} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({ body: { gap: space.block, minWidth: 0 } });
