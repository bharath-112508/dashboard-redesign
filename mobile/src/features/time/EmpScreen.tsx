import { useMemo, useState } from 'react';

import { EmptyBlock } from '@/components/EmptyBlock';
import { Screen } from '@/components/Screen';
import { company as companyOf, entriesAll, me, myCan, projectsOfCompany, projOpts } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { useRootActions } from '@/nav/useRootActions';

import { TeamTimesheet } from './TeamTimesheet';

/** S5-EMP Employee timesheets (super, admin, pm): every person's entries. */
export function EmpScreen() {
  const actions = useRootActions();
  const all = useAppState(entriesAll);
  const opts = useAppState(projOpts);
  return (
    <Screen title="Employee timesheets" sub="All projects and employees" actions={actions} testID="screen-emp">
      <TeamTimesheet source={all} allProjects="All projects" projects={opts} team csvName="employee-timesheets.csv" initialPeriod="week" hint="Click to filter" />
    </Screen>
  );
}

/**
 * S5-COTS Company timesheets (`company-time/[id]?pf=`): the company's projects. Without
 * Employee Timesheets access it shows only my hours and no Employee filter.
 */
export function CompanyTimeScreen({ id, pf }: { id: string; pf?: string }) {
  const c = useAppState((s) => companyOf(s, id));
  const projects = useAppState((s) => projectsOfCompany(s, id));
  const team = useAppState((s) => myCan(s, 'Employee Timesheets'));
  const myName = useAppState((s) => me(s)?.name ?? '');
  const all = useAppState(entriesAll);
  const [cur, setCur] = useState(pf || 'all');
  const ids = useMemo(() => new Set(projects.map((p) => `c:${p.id}`)), [projects]);
  const source = useMemo(() => all.filter((e) => ids.has(e.proj) && (team || e.who === myName)), [all, ids, team, myName]);
  if (!c) {
    return (
      <Screen title="Timesheets" testID="screen-company-time">
        <EmptyBlock text="Company not found." />
      </Screen>
    );
  }
  const one = projects.find((p) => `c:${p.id}` === cur);
  return (
    <Screen title={`Timesheets · ${c.name}`} sub={(one ? one.name : 'All projects') + (team ? '' : ' · your hours')} testID="screen-company-time">
      <TeamTimesheet
        source={source}
        allProjects={`All ${c.name} projects`}
        projects={projects.map((p) => ({ value: `c:${p.id}`, label: p.name }))}
        team={team}
        csvName={`timesheets-${c.id}.csv`}
        initialPeriod="all"
        initialProject={pf || 'all'}
        hint="Tap to filter"
        hideFiltered
        onProject={setCur}
      />
    </Screen>
  );
}
