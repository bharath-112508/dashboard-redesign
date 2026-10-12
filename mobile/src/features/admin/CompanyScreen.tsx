import { useState } from 'react';

import { Avatar, CompanyTile, IconTile } from '@/components/Avatar';
import { ConfirmSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { EmptyBlock } from '@/components/EmptyBlock';
import { Hero } from '@/components/Hero';
import { ProgressList } from '@/components/ProgressList';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { TextBlock } from '@/components/TextBlock';
import { Timeline } from '@/components/Timeline';
import { openTicket } from '@/components/TicketRow';
import { toastResult } from '@/components/Toast';
import { PROJECT_STATE } from '@/data/constants';
import { fmt, hm } from '@/data/format';
import { company as companyOf, entriesAll, myCan, myPerm, projectsOfCompany } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { href, openSheet, push } from '@/nav/routes';
import { colors } from '@/theme';

import { useTimeLabels } from '../time/labels';
import { totalsBy } from '../time/timeMath';

/**
 * S5-COMPANY: hero, archived note, About, Projects, Epics, Client contacts, Responsible
 * from Viljetech, Timesheets, Recent activity, Archive / Restore (V-81…V-83).
 */
export function CompanyScreen({ id }: { id: string }) {
  const c = useAppState((s) => companyOf(s, id));
  const projects = useAppState((s) => projectsOfCompany(s, id));
  const epics = useAppState((s) => s.epics);
  const people = useAppState((s) => s.people);
  const tickets = useAppState((s) => s.tickets);
  const entries = useAppState(entriesAll);
  const canEdit = useAppState((s) => myPerm(s, 'companies.edit'));
  const canTime = useAppState((s) => myCan(s, 'Employee Timesheets') || myCan(s, 'Timesheet'));
  const { setCompanyArchived } = useActions();
  const [confirm, setConfirm] = useState(false);
  const L = useTimeLabels();
  if (!c) {
    return (
      <Screen title="Company" testID="screen-company">
        <EmptyBlock text="Company not found." />
      </Screen>
    );
  }
  const pids = new Set(projects.map((p) => p.id));
  const name = (pid: string) => projects.find((p) => p.id === pid)?.name ?? '';
  const ep = epics.filter((e) => pids.has(e.projectId));
  const team = [...new Set(projects.flatMap((p) => p.team))];
  const byProj = totalsBy(
    entries.filter((e) => pids.has(e.proj.slice(2)) && e.proj.startsWith('c:')),
    (e) => e.proj,
  );
  const maxP = Math.max(1, ...byProj.map((x) => x.min));
  const activity = tickets
    .filter((t) => pids.has(t.projectId))
    .flatMap((t) => t.comments.map((x) => ({ ...x, k: t.key })))
    .slice(0, 4);
  return (
    <Screen title={c.name} sub={c.industry} testID="screen-company">
      <Hero
        lead={<CompanyTile name={c.name} logo={c.logo} size={46} radius={13} />}
        eyebrow={c.archived ? 'Archived' : c.industry || 'Company'}
        title={c.name}
        sub={[c.country, c.web].filter(Boolean).join(' · ')}
        testID="company-hero"
      />
      {c.archived ? <TextBlock tone="note" text="This company is archived and hidden from the list. Nothing was deleted." testID="company-archived" /> : null}
      <Block title="About" action={canEdit ? 'Edit' : undefined} onAction={canEdit ? () => openSheet('company', { id: c.id }) : undefined} actionTestID="company-edit">
        <TextBlock text={c.notes || 'No notes yet.'} testID="company-about" />
      </Block>
      <Block
        title="Projects"
        action={canEdit ? '+ Start new project' : undefined}
        onAction={canEdit ? () => openSheet('new-project', { co: c.id }) : undefined}
        actionTestID="company-new-project"
      >
        <Rows empty="No projects yet" testID="company-projects">
          {projects.map((p) => {
            const st = PROJECT_STATE[p.state];
            return (
              <Row
                key={p.id}
                lead={<IconTile icon="folder-kanban" bg={colors.primarySoft} fg={colors.primaryInk} />}
                title={p.name}
                sub={(p.desc || '') + (p.due ? ` · Deadline ${fmt(p.due)}` : '')}
                badge={{ label: st.label, tone: st.tone }}
                bar={p.state !== 'maint' ? { pct: p.pct, label: `${p.pct}%` } : undefined}
                onPress={() => push(href.project(p.id))}
              />
            );
          })}
        </Rows>
      </Block>
      <Block title="Epics">
        <ProgressList
          empty="No epics yet. Plan them in Tickets."
          items={ep.map((e) => ({ title: e.name, used: e.pct, of: 100, caption: `${name(e.projectId)} · ${e.sprints} sprints`, color: colors.green }))}
        />
      </Block>
      <Block
        title="Client contacts"
        sub="Can see their projects in the portal"
        action={canEdit ? '+ Add' : undefined}
        onAction={canEdit ? () => openSheet('contact', { co: c.id }) : undefined}
        actionTestID="company-add-contact"
      >
        <Rows empty="Nobody added yet." testID="company-contacts">
          {c.contacts.map((x, i) => (
            <Row
              key={`${x.email}-${i}`}
              lead={<Avatar name={x.name} />}
              title={x.name}
              sub={[x.role, x.email].filter(Boolean).join(' · ')}
              badge={x.admin ? { label: 'Portal admin', tone: 'amber' } : undefined}
              meta={[{ icon: 'folder', text: x.projects.length ? x.projects.map(name).filter(Boolean).join(', ') : 'No project assigned' }]}
              onPress={canEdit ? () => openSheet('contact', { co: c.id, i }) : undefined}
              testID={`contact-${i}`}
            />
          ))}
        </Rows>
      </Block>
      <Block title="Responsible from Viljetech" sub="Our people and the projects they own">
        <Rows empty="No team yet">
          {team.map((n) => (
            <Row
              key={n}
              lead={<Avatar name={n} />}
              title={n}
              sub={c.ourRoles[n] || people.find((p) => p.name === n)?.devType || ''}
              right={projects
                .filter((p) => p.team.includes(n))
                .map((p) => p.name)
                .join(', ')}
            />
          ))}
        </Rows>
      </Block>
      {canTime ? (
        <Block title="Timesheets" sub="All time" action="View all ›" onAction={() => push(href.companyTime(c.id))} actionTestID="company-time-all">
          <ProgressList
            testID="company-time"
            empty="No hours logged yet"
            items={byProj.map((x) => ({ title: L.proj(x.key), used: x.min, of: maxP, value: hm(x.min), onPress: () => push(href.companyTime(c.id, x.key)) }))}
          />
        </Block>
      ) : null}
      <Block title="Recent activity">
        <Timeline
          items={
            activity.length
              ? activity.map((x) => ({ dot: colors.primary, ring: colors.primarySoft, k: x.k, kColor: colors.primaryInk, title: `${x.who} commented`, sub: x.t, right: x.when, onPress: () => openTicket(x.k) }))
              : [{ dot: colors.faint, ring: colors.track, title: 'No activity yet', titleColor: colors.ink3 }]
          }
        />
      </Block>
      {canEdit ? (
        c.archived ? (
          <Button title="Restore company" icon="archive-restore" onPress={() => toastResult(setCompanyArchived(c.id, false))} testID="company-restore" />
        ) : (
          <Button title="Archive" icon="archive" kind="d" onPress={() => setConfirm(true)} testID="company-archive" />
        )
      ) : null}
      <ConfirmSheet
        visible={confirm}
        title="Archive company"
        text="The company moves to the Archived tab and is hidden from the list. Nothing is deleted, and you can restore it at any time."
        confirm="Archive company"
        onClose={() => setConfirm(false)}
        onConfirm={() => toastResult(setCompanyArchived(c.id, true))}
        testID="confirm-archive"
      />
    </Screen>
  );
}
