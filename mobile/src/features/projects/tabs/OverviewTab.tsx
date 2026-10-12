import { useMemo } from 'react';

import { Block, IconTile, KpiGrid, openTicket, ProgressList, Row, Rows, TicketRow, Timeline, type Kpi } from '@/components';
import { fmt, hm } from '@/data/format';
import type { ProjectView } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { colors } from '@/theme';

import { overview } from '../derive';
import type { Jump } from './types';

/** Overview tab: KPIs, epics progress; staff add attention, estimates, missed sprints, time, activity. */
export function OverviewTab({ p, client, jump }: { p: ProjectView; client: boolean; jump: Jump }) {
  const state = useStoreState();
  const o = useMemo(() => overview(state, p), [state, p]);
  const listTab = client ? 'board' : 'list';
  const kpis: Kpi[] = [
    { label: 'Open tickets', value: String(o.open), sub: `${o.done} done`, dot: colors.primary, onPress: () => jump(listTab, { st: 'open' }), testID: 'kpi-open' },
    {
      label: 'Overdue',
      value: String(o.late.length),
      sub: `${o.critical.length} critical`,
      dot: colors.danger,
      color: o.late.length ? colors.danger : colors.ink,
      onPress: () => jump(listTab, { st: 'late' }),
      testID: 'kpi-overdue',
    },
    ...(client ? [] : [{ label: 'Hours logged', value: hm(o.loggedMin), sub: 'All time', dot: colors.ink, onPress: () => jump('time'), testID: 'kpi-hours' }]),
    { label: 'Progress', value: `${p.pct}%`, sub: p.due ? `Deadline ${fmt(p.due)}` : '', dot: colors.green },
  ];
  const max = Math.max(1, ...o.byPerson.map((x) => x.min));
  return (
    <>
      <KpiGrid items={kpis} testID="project-kpis" />
      <Block title="Epics" sub="Tasks done per epic">
        <ProgressList
          items={o.epics.map((e) => ({
            title: e.name,
            used: e.done,
            of: e.total || 1,
            caption: e.caption,
            color: colors.green,
            onPress: () => jump('board', { epic: e.id }),
          }))}
          testID="overview-epics"
        />
      </Block>
      {client ? null : (
        <>
          <Block title="Needs attention" sub="Overdue or critical">
            <Rows empty="Nothing needs attention" testID="overview-attention">
              {o.attention.map((t) => (
                <TicketRow key={t.key} ticket={t} />
              ))}
            </Rows>
          </Block>
          <Block title="Over estimate">
            <Rows empty="Every task is within its estimate" testID="overview-over">
              {o.over.map(({ ticket: t, min }) => (
                <TicketRow key={t.key} ticket={t} row={{ badge: undefined, right: `${hm(min)} / ${t.est}h`, rightColor: colors.danger }} />
              ))}
            </Rows>
          </Block>
          <Block title="Missed timelines">
            <Rows empty="No missed sprint or task deadlines" testID="overview-missed">
              {o.missed.map((s) => (
                <Row
                  key={s.id}
                  lead={<IconTile icon="alarm-clock" bg={colors.redSoft} fg={colors.redInk} />}
                  title={`${s.epicName} · ${s.name}`}
                  sub={`Ended ${fmt(s.end)} · not completed`}
                />
              ))}
            </Rows>
          </Block>
          <Block title="Time spent" sub="by person">
            <ProgressList
              items={o.byPerson.map((x) => ({ title: x.who, used: x.min, of: max, caption: `${hm(x.min)} logged`, value: hm(x.min), color: colors.primary }))}
              empty="No hours logged yet"
              testID="overview-time"
            />
          </Block>
          <Block title="Recent activity">
            <Timeline
              items={
                o.activity.length
                  ? o.activity.map((c) => ({
                      dot: colors.primary,
                      ring: colors.primarySoft,
                      k: c.key,
                      kColor: colors.primaryInk,
                      title: `${c.who} commented`,
                      sub: c.t,
                      right: c.when,
                      onPress: () => openTicket(c.key),
                    }))
                  : [{ dot: colors.faint, ring: colors.track, title: 'No activity yet', titleColor: colors.ink3 }]
              }
              testID="overview-activity"
            />
          </Block>
        </>
      )}
    </>
  );
}
