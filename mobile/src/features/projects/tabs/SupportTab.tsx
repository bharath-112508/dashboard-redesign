import { Block, Button, ButtonRow, FieldList, IconTile, KpiGrid, ProgressList, Row, Rows, TicketRow } from '@/components';
import { fmt, hm } from '@/data/format';
import { SUPPORT_DEMO, UPKEEP_TASKS } from '@/data/seed/dashboardDemo';
import { canSetProjectStatus, isClient, myName, myRole, projValue, ticketsOf, type ProjectView } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { Ticket } from '@/data/types';
import { openLog } from '@/features/time/openLog';
import { openSheet } from '@/nav/routes';
import { colors } from '@/theme';

const UPKEEP_ICON = ['shield-check', 'hard-drive'] as const;

const kindLabel = (t: Ticket, long: boolean) => (t.support === 'problem' ? 'Problem' : long ? 'Change request' : 'Change');

/**
 * Support tab of a maintenance project. Client: KPIs, report a problem (V-55; clients do
 * not request changes), requests and terms. super/admin/pm: hours, request queue, editable terms (V-54).
 * dev/devops: assigned support tickets and upkeep tasks that open SH-LOG preset (V-16).
 */
export function SupportTab({ p }: { p: ProjectView }) {
  const client = useAppState(isClient);
  const role = useAppState(myRole);
  const me = useAppState(myName);
  const RQ = useAppState((s) => ticketsOf(s, p.id).filter((t) => !!t.support));
  const sup = p.sup ?? { until: '', used: 0, quota: 10 };
  const left = Math.max(0, sup.quota - sup.used);
  const open = RQ.filter((t) => t.st !== 'done');
  const terms = () => openSheet('support-terms', { id: p.id });

  if (client) {
    return (
      <>
        <KpiGrid
          items={[
            { label: 'Uptime', value: SUPPORT_DEMO.uptime, sub: 'Last 30 days', dot: colors.green },
            { label: 'Incidents', value: String(SUPPORT_DEMO.incidents), sub: 'Last 30 days · resolved', dot: colors.amberDot },
            { label: 'Support hours left', value: hm(left * 60), of: `/ ${sup.quota}h`, sub: 'This month', dot: colors.primary },
            { label: 'Open requests', value: String(open.length), dot: colors.orange },
          ]}
          testID="support-kpis"
        />
        <ButtonRow>
          <Button title="Report a problem" kind="d" icon="triangle-alert" onPress={() => openSheet('support-request', { pid: p.id, kind: 'problem' })} testID="support-report-problem" />
        </ButtonRow>
        <Block title="Your requests">
          <Rows empty="No requests yet." testID="support-your-requests">
            {RQ.map((t) => (
              <TicketRow key={t.key} ticket={t} sub={`${kindLabel(t, true)} · ${t.due ? `Target ${fmt(t.due)}` : ''}`} />
            ))}
          </Rows>
        </Block>
        <Block title="Support terms">
          <FieldList
            items={[
              { label: 'Live since', value: fmt(p.due) },
              { label: 'Support until', value: fmt(sup.until) },
              { label: 'Hours per month', value: `${sup.quota}h` },
            ]}
          />
        </Block>
      </>
    );
  }

  if (canSetProjectStatus(role)) {
    const months = [...SUPPORT_DEMO.hoursByMonth.slice(0, 3), { m: 'Oct', h: sup.used }];
    return (
      <>
        <KpiGrid
          items={[
            { label: 'Hours used', value: `${sup.used}h`, of: `/ ${sup.quota}h`, sub: `This month · ${left}h left`, dot: colors.primary, color: sup.used > sup.quota ? colors.danger : colors.ink },
            { label: 'SLA compliance', value: SUPPORT_DEMO.sla, sub: 'Responses within 4h', dot: colors.green },
            { label: 'Open requests', value: String(open.length), sub: `${RQ.length} this month`, dot: colors.orange },
            { label: 'Support until', value: fmt(sup.until), sub: 'Renewal due', dot: colors.teal },
          ]}
          testID="support-kpis"
        />
        <Block title="Support hours" sub="Used per month vs quota">
          <ProgressList items={months.map((x) => ({ title: `${x.m} 2026`, used: x.h, of: sup.quota, caption: `${x.h}h of ${sup.quota}h`, value: `${x.h}h` }))} />
        </Block>
        <Block title="Request queue" sub={`${open.length} open`}>
          <Rows empty="No open requests." testID="support-queue">
            {open.map((t) => (
              <TicketRow key={t.key} ticket={t} sub={`${kindLabel(t, false)} · ${t.as.length ? t.as.join(', ') : 'Unassigned'}`} />
            ))}
          </Rows>
        </Block>
        <Block title="Support terms" sub="Editable per project">
          <FieldList
            items={[
              { label: 'Live since', value: fmt(p.due) },
              { label: 'Support until', value: fmt(sup.until), onPress: terms, icon: 'pencil', testID: 'terms-until' },
              { label: 'Hours per month', value: `${sup.quota}h`, onPress: terms, icon: 'pencil', testID: 'terms-quota' },
            ]}
            testID="support-terms"
          />
        </Block>
      </>
    );
  }

  const mine = RQ.filter((t) => t.as.includes(me));
  return (
    <>
      <Block title="Assigned to you" sub={`${mine.filter((t) => t.st !== 'done').length} open`}>
        <Rows empty="No support tickets assigned to you." testID="support-mine">
          {mine.map((t) => (
            <TicketRow key={t.key} ticket={t} />
          ))}
        </Rows>
      </Block>
      <Block title="Upkeep tasks">
        <Rows testID="support-upkeep">
          {UPKEEP_TASKS.map((u, i) => (
            <Row
              key={u.title}
              lead={<IconTile icon={UPKEEP_ICON[i] ?? 'shield-check'} />}
              title={u.title}
              label={`Log time: ${u.title}`}
              sub={`Due ${fmt(u.due)}`}
              right="Log time"
              rightColor={colors.primaryInk}
              rightWeight={700}
              chevron={false}
              onPress={() => openLog({ proj: projValue(p), text: u.title })}
              testID={`upkeep-${i}`}
            />
          ))}
        </Rows>
      </Block>
      <ButtonRow>
        <Button title="Log time" icon="timer" onPress={() => openLog({ proj: projValue(p) })} testID="support-log-time" />
      </ButtonRow>
    </>
  );
}
