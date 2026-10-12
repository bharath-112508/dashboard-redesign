import { Block, CompanyTileById, EmptyBlock, Hero, ProjectTile, Row, Rows, Screen, Avatar } from '@/components';
import { PROJECT_STATE } from '@/data/constants';
import { fmt } from '@/data/format';
import { clientTeamOf, company, isOpenQuestion, me, myRole, orgName, projAll, projVis, isClientRole, type ProjectView } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, openSheet, push, tab2 } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { BugRow, QuestionRow } from './rows';

/** A portal project row: tile, name, description (or support date), status, progress. */
function ProjectRow({ p }: { p: ProjectView }) {
  const st = PROJECT_STATE[p.state];
  const maint = p.state === 'maint';
  return (
    <Row
      lead={<ProjectTile id={p.id} />}
      title={p.name}
      sub={maint && p.sup ? `Live · support until ${fmt(p.sup.until)}` : p.desc}
      badge={{ label: st.label, tone: st.tone }}
      bar={maint ? undefined : { pct: p.pct, color: colors.green, label: `${p.pct}%` }}
      onPress={() => push(href.project(p.id))}
      testID={`portal-project-${p.id}`}
    />
  );
}

/**
 * S5-PORTAL. Client view: the `projects` tab for cadmin/cuser (no `co`). Staff view:
 * `portal/[co]` (dark hero "What X sees when they sign in", "+ Raise" questions).
 */
export function PortalScreen({ co }: { co?: string }) {
  const role = useAppState(myRole);
  const cl = isClientRole(role);
  const coId = useAppState((s) => co ?? me(s)?.org ?? 'daco');
  const c = useAppState((s) => company(s, coId));
  const org = useAppState((s) => {
    const u = me(s);
    return u ? orgName(s, u) : '';
  });
  const P = useAppState((s) => (cl ? projVis(s) : projAll(s).filter((p) => p.coId === coId)));
  const ids = new Set(P.map((p) => p.id));
  const waiting = useAppState((s) => s.questions.filter((q) => ids.has(q.projectId) && isOpenQuestion(q)));
  const bugs = useAppState((s) => s.bugs.filter((b) => ids.has(b.projectId)));
  const team = useAppState((s) => clientTeamOf(s, coId));
  const root = useRootActions();
  const name = c?.name ?? org;

  return (
    <Screen title={cl ? 'Projects' : name} sub={cl ? org : 'Client portal'} actions={cl ? root : []} testID={cl ? 'screen-projects' : 'screen-portal'}>
      {!cl ? (
        <Hero variant="dark" lead={<CompanyTileById id={coId} size={46} radius={13} />} eyebrow="Client portal" title={name} sub={`What ${name} sees when they sign in`} testID="portal-hero" />
      ) : null}
      <Block title={cl ? 'Your projects' : 'Projects'} sub="Progress">
        <Rows empty="No projects yet." testID="portal-projects">
          {P.map((p) => (
            <ProjectRow key={p.id} p={p} />
          ))}
        </Rows>
      </Block>
      <Block
        title={cl ? 'Questions waiting for you' : 'Questions to client'}
        sub={`${waiting.length} waiting`}
        action={cl ? 'All ›' : P[0] ? '+ Raise' : undefined}
        onAction={() => (cl ? tab2('questions', role) : P[0] && openSheet('new-question', { pid: P[0].id }))}
        actionTestID={cl ? 'portal-questions-all' : 'portal-raise'}
      >
        <Rows empty="No questions waiting." testID="portal-questions">
          {waiting.map((q) => (
            <QuestionRow key={q.id} q={q} />
          ))}
        </Rows>
      </Block>
      <Block
        title="Bugs reported"
        action={cl ? '+ Report a bug' : undefined}
        onAction={() => openSheet('report-bug', P[0] ? { pid: P[0].id } : {})}
        actionTestID="portal-report-bug"
      >
        <Rows empty="No bugs reported." testID="portal-bugs">
          {bugs.slice(0, 4).map((b) => (
            <BugRow key={b.id} b={b} />
          ))}
        </Rows>
      </Block>
      {!cl || role === 'cadmin' ? (
        <Block
          title="Your team"
          sub="They can report bugs and answer questions."
          action={role === 'cadmin' ? '+ Add' : undefined}
          onAction={() => openSheet('client-member')}
          actionTestID="portal-team-add"
        >
          {team.length ? (
            <Rows testID="portal-team">
              {team.map((m) => (
                <Row
                  key={m.id}
                  lead={<Avatar name={m.name} />}
                  title={m.name}
                  sub={`${m.title} · ${m.email}`}
                  onPress={role === 'cadmin' ? () => openSheet('client-member', { email: m.email }) : undefined}
                  testID={`portal-member-${m.id}`}
                />
              ))}
            </Rows>
          ) : (
            <EmptyBlock text="No one added yet." />
          )}
        </Block>
      ) : null}
    </Screen>
  );
}
