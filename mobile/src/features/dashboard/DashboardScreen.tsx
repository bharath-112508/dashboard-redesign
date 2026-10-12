import { useMemo } from 'react';

import {
  Block,
  Button,
  KpiGrid,
  ProgressList,
  Row,
  Rows,
  Screen,
  StepBars,
  TicketRow,
  WeekBars,
  openTicket,
  type Kpi,
} from '@/components';
import { myCan, myRole } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { openLog } from '@/features/time/openLog';
import { href, push, tab2 } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import type { Role } from '@/data/types';

import { buildDashboard, type Target, type Widget } from './widgets';

/** Navigate to a dashboard target (V-07): pages via `tab2`, records pushed. */
export function goTarget(t: Target, role: Role | null): void {
  if ('page' in t) tab2(t.page, role);
  else if ('ticket' in t) openTicket(t.ticket);
  else if ('project' in t) push(href.project(t.project));
  else if ('question' in t) push(href.question(t.question));
  else if ('bug' in t) push(href.bug(t.bug));
  else if ('request' in t) push(href.request(t.request));
  else push(href.dvp(t.dvp));
}

/** S5-DASH Dashboard: "Log your time", 4 KPIs and the role's widgets (live numbers, A-1). */
export function DashboardScreen() {
  const s = useStoreState();
  const role = myRole(s);
  const d = useMemo(() => buildDashboard(s), [s]);
  const canLog = myCan(s, 'Timesheet');
  const actions = useRootActions();
  if (!d) return null;
  const go = (t: Target) => () => goTarget(t, role);
  const kpis: Kpi[] = d.kpis.map((k, i) => ({ ...k, onPress: go(k.go), testID: `dash-kpi-${i}` }));
  return (
    <Screen title="Dashboard" sub={d.scope} actions={actions} testID="screen-home">
      {canLog ? <Button title="Log your time" icon="timer" onPress={() => openLog()} testID="dash-log-time" /> : null}
      <KpiGrid items={kpis} testID="dash-kpis" />
      {d.widgets.map((w) => (
        <Block key={w.id} title={w.title} sub={w.sub} action={`${w.link} ›`} onAction={go(w.go)} actionTestID={`dash-link-${w.id}`} testID={`dash-w-${w.id}`}>
          <WidgetBody w={w} role={role} />
        </Block>
      ))}
    </Screen>
  );
}

function WidgetBody({ w, role }: { w: Widget; role: Role | null }) {
  const s = useStoreState();
  const go = (t?: Target) => (t ? () => goTarget(t, role) : undefined);
  switch (w.k) {
    case 'prog':
      return <ProgressList items={w.items.map((x) => ({ ...x, onPress: go(x.go) }))} empty={w.empty} />;
    case 'bars':
      return <WeekBars days={w.days} idle={w.idle} foot={w.foot} />;
    case 'status':
      return <StepBars rows={w.items.map((x) => ({ ...x, onPress: go(x.go) }))} empty={w.empty} />;
    case 'tix':
      return (
        <Rows empty={w.empty}>
          {w.keys.map((k) => {
            const t = s.tickets.find((x) => x.key === k);
            return t ? <TicketRow key={k} ticket={t} /> : null;
          })}
        </Rows>
      );
    case 'list':
      return (
        <Rows empty={w.empty}>
          {w.items.map((x, i) => (
            <Row
              key={i}
              title={x.title}
              sub={x.sub}
              badge={{ label: x.badge.label, tone: x.badge.tone }}
              right={x.right}
              rightColor={x.rightColor}
              onPress={go(x.go)}
              chevron={false}
              testID={`dash-${w.id}-row-${i}`}
            />
          ))}
        </Rows>
      );
  }
}
