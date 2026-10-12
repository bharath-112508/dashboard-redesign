/** Maintenance Support (client / staff / IC modes) and Report views (M-30–M-34). */
import { ScrollView, StyleSheet, View } from 'react-native';

import { Dot, Icon, Press, ProgressBar, showToast, Txt } from '@/components';
import { useActions, useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { colors, radii } from '@/theme';

import { maintenanceVM, reportToast, type MaintVM } from '../maintenance';
import { Eyebrow4, InfoTile, partStyles, PillButton, RequestRow, RowsCard, SmallPill, TaskRow, ViewIn } from '../parts';

export function SupportView({ project }: { project: string }) {
  const vm = useAppState((s) => maintenanceVM(s, project));
  const { toggleRequestBilling, assignRequest, toggleUpkeepTask, setProjectView } = useActions();
  const goReport = () => setProjectView(project, 'rep');
  const toggleTask = (id: string) => toggleUpkeepTask(project, id);

  if (vm.mode === 'client') {
    return (
      <ViewIn>
        <View style={partStyles.card} testID="support-client">
          <View style={styles.row10}>
            <View style={styles.healthIcon}>
              <Icon name="activity" size={18} color={colors.greenInk} />
            </View>
            <View>
              <Txt v="titleSm" w={800}>
                Everything is running
              </Txt>
              <Txt v="caption" color={colors.ink3}>{`${vm.health.uptime} uptime, last 30 days`}</Txt>
            </View>
          </View>
          <View style={partStyles.grid2}>
            <InfoTile label="Last incident" value={vm.health.incident} small />
            <InfoTile label="Next maintenance" value={vm.health.window} small />
          </View>
        </View>
        <View style={partStyles.grid2}>
          <PillButton
            label="Report a problem"
            icon="bug"
            dark
            style={styles.flex}
            onPress={() => openSheet('report', { project, kind: 'Bug' })}
            testID="support-report-problem"
          />
          <PillButton
            label="Request a change"
            icon="pencil-line"
            style={styles.flex}
            onPress={() => openSheet('report', { project, kind: 'Change' })}
            testID="support-request-change"
          />
        </View>
        {vm.hasHours ? <HoursCard vm={vm} /> : null}
        {vm.hasSla ? <SlaCard vm={vm} /> : null}
        <Eyebrow4>Your requests</Eyebrow4>
        <RowsCard testID="requests">
          {vm.requests.map((r, i) => (
            <RequestRow key={r.id} r={r} first={i === 0} />
          ))}
          {!vm.requests.length ? <EmptyLine text="No requests yet." /> : null}
        </RowsCard>
        <Eyebrow4>Recent updates</Eyebrow4>
        <RowsCard testID="releases">
          {vm.releases.map((v, i) => (
            <View key={v.v} style={[styles.rel, i > 0 && partStyles.divider]}>
              <View style={styles.relV}>
                <Txt v="meta" w={800}>
                  {v.v}
                </Txt>
                <Txt v="small" w={400} color={colors.ink3}>
                  {v.date}
                </Txt>
              </View>
              <Txt v="bodySm" w={400} color={colors.inkBody} style={styles.relText}>
                {v.text}
              </Txt>
            </View>
          ))}
          {!vm.releases.length ? <EmptyLine text="No releases yet." /> : null}
        </RowsCard>
        <PillButton label="Monthly report" icon="file-down" onPress={goReport} testID="support-monthly-report" />
      </ViewIn>
    );
  }

  if (vm.mode === 'staff') {
    return (
      <ViewIn>
        <View style={styles.planBar} testID="support-staff">
          <View style={styles.planLabel}>
            <Icon name="file-pen-line" size={15} color={colors.tealInk} />
            <Txt v="meta" w={700} color={colors.tealInk} style={styles.flexShrink}>
              {vm.planLabel}
            </Txt>
          </View>
          <SmallPill label="Edit plan" icon="pencil" onPress={() => openSheet('support-plan', { project })} testID="support-edit-plan" />
          <SmallPill label="Report" icon="file-chart-column" dark onPress={goReport} testID="support-report" />
        </View>
        {vm.hasHours ? <HoursCard vm={vm} /> : null}
        {vm.hasSla ? <SlaCard vm={vm} /> : null}
        {vm.hasHours ? <HoursChart vm={vm} /> : null}
        <View style={partStyles.grid2}>
          <View style={styles.statTile}>
            <Txt v="small" w={700} color={colors.ink3}>
              Response time
            </Txt>
            <Txt v="rowTitle" w={800} style={styles.mt4}>
              {vm.sla.onTime}
            </Txt>
          </View>
          <View style={styles.statTile} testID="to-quote">
            <Txt v="small" w={700} color={colors.ink3}>
              To quote
            </Txt>
            <Txt v="rowTitle" w={800} style={styles.mt4}>{`${vm.hours.toQuote} requests`}</Txt>
          </View>
        </View>
        <Eyebrow4>{`Request queue · ${vm.openCount} open`}</Eyebrow4>
        <RowsCard testID="requests">
          {vm.requests.map((r, i) => (
            <RequestRow
              key={r.id}
              r={r}
              first={i === 0}
              staff
              onToggleBill={() => toggleRequestBilling(project, r.id)}
              onAssign={() => showToast(assignRequest(project, r.id))}
            />
          ))}
          {!vm.requests.length ? <EmptyLine text="No open requests." /> : null}
        </RowsCard>
        <Eyebrow4>Upkeep tasks</Eyebrow4>
        <RowsCard testID="tasks">
          {vm.tasks.map((t, i) => (
            <TaskRow key={t.id} t={t} first={i === 0} onToggle={() => toggleTask(t.id)} />
          ))}
          {!vm.tasks.length ? <EmptyLine text="No upkeep tasks for you." /> : null}
        </RowsCard>
      </ViewIn>
    );
  }

  // IC staff (dev, free, devops)
  return (
    <ViewIn>
      <Eyebrow4>Assigned to you</Eyebrow4>
      {vm.myRequests.length ? (
        <RowsCard testID="requests">
          {vm.myRequests.map((r, i) => (
            <RequestRow key={r.id} r={r} first={i === 0} />
          ))}
        </RowsCard>
      ) : (
        <View style={partStyles.card} testID="requests">
          <Txt v="bodySm" w={400} color={colors.ink3}>
            No support requests assigned to you.
          </Txt>
        </View>
      )}
      <PillButton
        label="Log time to support plan"
        icon="timer"
        dark
        onPress={() => openSheet('log-time', { project, text: `${project} · support` })}
        testID="support-log-time"
      />
      <Eyebrow4>Environments</Eyebrow4>
      <RowsCard testID="environments">
        {vm.environments.map((e, i) => (
          <View key={e.label} style={[styles.env, i > 0 && partStyles.divider]}>
            <Dot color={colors.green} size={8} />
            <View style={styles.flex}>
              <Txt v="bodyLg" w={700} style={styles.lh19}>
                {e.label}
              </Txt>
              <Txt v="caption" color={colors.ink3}>
                {e.url}
              </Txt>
            </View>
            <Txt v="caption" w={700} color={colors.greenInk}>
              {e.health}
            </Txt>
          </View>
        ))}
        <View style={[styles.version, vm.environments.length > 0 && partStyles.divider]}>
          <Txt v="meta" w={400} color={colors.ink3}>
            {'Live version '}
            <Txt v="meta" w={800}>
              {vm.health.version}
            </Txt>
            {` · deployed ${vm.health.deployed}`}
          </Txt>
        </View>
      </RowsCard>
      <Eyebrow4>Your upkeep tasks</Eyebrow4>
      <RowsCard testID="tasks">
        {vm.tasks.map((t, i) => (
          <TaskRow key={t.id} t={t} first={i === 0} onToggle={() => toggleTask(t.id)} />
        ))}
        {!vm.tasks.length ? <EmptyLine text="No upkeep tasks for you." /> : null}
      </RowsCard>
    </ViewIn>
  );
}

function EmptyLine({ text }: { text: string }) {
  return (
    <Txt v="bodySm" w={400} color={colors.ink3} style={styles.emptyLine}>
      {text}
    </Txt>
  );
}

function HoursCard({ vm }: { vm: MaintVM }) {
  return (
    <View style={partStyles.card} testID="hours-card">
      <View style={styles.between}>
        <Txt v="meta" w={700} color={colors.ink3}>
          Support hours this month
        </Txt>
        <Txt v="meta" w={800} color={vm.hours.leftColor}>
          {vm.hours.left}
        </Txt>
      </View>
      <View style={styles.baseline}>
        <Txt v="kpi">{vm.hours.used}</Txt>
        <Txt v="body" w={600} color={colors.ink3}>{`of ${vm.hours.quota}`}</Txt>
      </View>
      <ProgressBar pct={vm.hours.pct} height={8} color={colors.teal} track={colors.primarySoft} label="Support hours used" />
      <Txt v="caption" color={colors.ink3}>{`${vm.hours.rollLabel} · ${vm.hours.overLabel}`}</Txt>
    </View>
  );
}

function SlaCard({ vm }: { vm: MaintVM }) {
  return (
    <View style={partStyles.card} testID="sla-card">
      <View style={styles.row8}>
        <Icon name="shield-check" size={18} color={colors.tealInk} />
        <Txt v="meta" w={700} color={colors.ink3}>{`Service level · ${vm.sla.cover}`}</Txt>
      </View>
      <View style={partStyles.grid2}>
        <InfoTile label="First reply" value={vm.sla.resp} />
        <InfoTile label="Blocking fix" value={vm.sla.fix} />
      </View>
      <Txt v="caption" color={colors.ink3}>{`${vm.sla.onTime} · Renews ${vm.sla.renew}`}</Txt>
    </View>
  );
}

function HoursChart({ vm }: { vm: MaintVM }) {
  const bars = vm.hours.bars;
  return (
    <View style={[partStyles.card, styles.gap8]} testID="hours-chart">
      <Txt v="meta" w={700} color={colors.ink3}>
        Hours per month
      </Txt>
      {bars.length ? (
        <>
          <View style={styles.chart}>
            <View style={[styles.planLine, { bottom: `${vm.hours.planLinePct}%` }]} />
            {bars.map((b) => (
              <View key={b.month} style={styles.barCol}>
                <Txt v="small" w={700} style={styles.fs11}>
                  {b.hours}
                </Txt>
                <View style={[styles.bar, { height: `${b.pct}%`, backgroundColor: b.over ? colors.danger : colors.teal }]} />
              </View>
            ))}
          </View>
          <View style={styles.barLabels}>
            {bars.map((b) => (
              <Txt key={b.month} v="chip" color={colors.ink3} align="center" style={styles.flex}>
                {b.month}
              </Txt>
            ))}
          </View>
        </>
      ) : (
        <Txt v="bodySm" w={400} color={colors.ink3}>
          No hours logged yet.
        </Txt>
      )}
      <Txt v="small" w={400} color={colors.ink3}>
        Dashed line is the plan. Red months went over the plan.
      </Txt>
    </View>
  );
}

// ── Report (M-33) ───────────────────────────────────────────────────────────

export function ReportView({ project }: { project: string }) {
  const vm = useAppState((s) => maintenanceVM(s, project));
  const reportMonth = useAppState((s) => s.ui.reportMonth);
  const { setUi } = useActions();
  const r = vm.report;
  return (
    <ViewIn>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.months} accessibilityRole="radiogroup" accessibilityLabel="Report month">
        {r.months.map((m) => {
          const on = m === r.month;
          return (
            <Press
              key={m}
              label={m}
              a11yRole="radio"
              checked={on}
              onPress={() => setUi({ reportMonth: { ...reportMonth, [project]: m } })}
              scale={0.97}
              style={[styles.month, on ? styles.monthOn : styles.monthOff]}
              testID={`month-${m}`}
            >
              <Txt v="meta" w={700} color={on ? colors.white : colors.ink}>
                {m}
              </Txt>
            </Press>
          );
        })}
      </ScrollView>
      <View style={[partStyles.card, styles.repCard]} testID="report-card">
        <View>
          <Txt v="eyebrow" color={colors.tealInk} style={styles.ls06}>
            Monthly report
          </Txt>
          <Txt v="sheetTitle" style={styles.mt2}>
            {r.title}
          </Txt>
          <Txt v="caption" color={colors.ink3}>
            {r.sent}
          </Txt>
        </View>
        <View style={styles.kpis}>
          {pairs(r.kpis).map((row) => (
            <View key={row[0].label} style={partStyles.grid2}>
              {row.map((k) => (
                <View key={k.label} style={styles.kpi}>
                  <Txt v="small" w={700} color={colors.ink3}>
                    {k.label}
                  </Txt>
                  <Txt v="titleSm" w={800} numberOfLines={1} style={styles.mt3}>
                    {k.value}
                  </Txt>
                </View>
              ))}
              {row.length === 1 ? <View style={styles.flex} /> : null}
            </View>
          ))}
        </View>
      </View>
      <Eyebrow4>Where the time went</Eyebrow4>
      <View style={partStyles.card}>
        {r.split.map((x) => (
          <View key={x.label} style={styles.row10}>
            <Txt v="bodySm" w={700} style={styles.splitL}>
              {x.label}
            </Txt>
            <ProgressBar pct={x.pct} height={10} color={colors.teal} track={colors.divider2} style={styles.flex} label={`${x.label} ${x.hours}`} />
            <Txt v="bodySm" w={800} align="right" style={styles.splitH}>
              {x.hours}
            </Txt>
          </View>
        ))}
      </View>
      <Eyebrow4>Work done</Eyebrow4>
      <RowsCard testID="work-done">
        {r.done.map((d, i) => (
          <View key={d} style={[styles.done, i > 0 && partStyles.divider]}>
            <Icon name="circle-check" size={17} color={colors.green} />
            <Txt v="body" style={styles.flex}>
              {d}
            </Txt>
          </View>
        ))}
        {!r.done.length ? <EmptyLine text="Nothing closed yet this month." /> : null}
      </RowsCard>
      <View style={partStyles.grid2}>
        <PillButton label="Download PDF" icon="file-down" style={styles.flex} onPress={() => showToast(reportToast.downloaded(r.month))} testID="report-download" />
        {vm.mode === 'staff' ? (
          <PillButton label="Send to client" icon="send" dark style={styles.flex} onPress={() => showToast(reportToast.sent(r.month))} testID="report-send" />
        ) : null}
      </View>
    </ViewIn>
  );
}

function pairs<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += 2) out.push(xs.slice(i, i + 2));
  return out;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  mt2: { marginTop: 2 },
  mt3: { marginTop: 3 },
  mt4: { marginTop: 4 },
  lh19: { lineHeight: 19 },
  fs11: { fontSize: 11 },
  ls06: { letterSpacing: 0.72 },
  gap8: { gap: 8 },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row10: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  between: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  baseline: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  healthIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.greenSoft, alignItems: 'center', justifyContent: 'center' },
  rel: { flexDirection: 'row', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  relV: { width: 52 },
  relText: { flex: 1, lineHeight: 19.5 },
  planBar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planLabel: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  statTile: { flex: 1, padding: 12, borderRadius: radii.compactCard, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  chart: { height: 96, flexDirection: 'row', alignItems: 'flex-end', gap: 12, paddingTop: 4 },
  planLine: { position: 'absolute', left: 0, right: 0, borderTopWidth: 1.5, borderTopColor: colors.faint, borderStyle: 'dashed' },
  barCol: { flex: 1, height: '100%', justifyContent: 'flex-end', alignItems: 'center', gap: 4 },
  bar: { width: '100%', maxWidth: 36, flexShrink: 1, minHeight: 0, borderTopLeftRadius: 6, borderTopRightRadius: 6, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 },
  barLabels: { flexDirection: 'row', gap: 12 },
  env: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14 },
  version: { paddingVertical: 12, paddingHorizontal: 14 },
  emptyLine: { padding: 16 },
  months: { gap: 8, paddingHorizontal: 2, paddingTop: 2, paddingBottom: 6 },
  month: { height: 36, paddingHorizontal: 16, borderRadius: 18, justifyContent: 'center', borderWidth: 1 },
  monthOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  monthOff: { backgroundColor: colors.surface, borderColor: colors.line },
  repCard: { padding: 16, gap: 12 },
  kpis: { gap: 8 },
  kpi: { flex: 1, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14, backgroundColor: colors.bg },
  splitL: { width: 70 },
  splitH: { width: 54 },
  done: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingVertical: 11, paddingHorizontal: 14 },
});
