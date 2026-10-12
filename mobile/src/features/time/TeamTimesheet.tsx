import { useMemo, useState } from 'react';

import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { Form, SelectField, type Option } from '@/components/fields';
import { KpiGrid } from '@/components/KpiGrid';
import { ProgressList } from '@/components/ProgressList';
import { Rows } from '@/components/Row';
import { FilterChips } from '@/components/Segmented';
import { showToast } from '@/components/Toast';
import { hm } from '@/data/format';
import type { TimeEntry } from '@/data/types';
import { colors } from '@/theme';

import { shareCsv } from './csv';
import { TeamEntryRow } from './EntryRow';
import { useTimeLabels } from './labels';
import { billMin, filterTeam, inRange, newestFirst, nonMin, periodRange, teamCsv, totalsBy, type Period } from './timeMath';

export interface TeamTimesheetProps {
  /** resolved entries in scope (all people, or only mine) */
  source: TimeEntry[];
  /** "All projects" option label */
  allProjects: string;
  projects: Option[];
  /** show the Employee filter and the By employee bars */
  team: boolean;
  csvName: string;
  initialPeriod: Period;
  initialProject?: string;
  /** "Click to filter" (emp) / "Tap to filter" (cots) */
  hint: string;
  /** cots hides a bar list once its filter is set */
  hideFiltered?: boolean;
  onProject?: (pf: string) => void;
}

/**
 * The body of S5-EMP and S5-COTS (V-15): period chips, Project / Employee selects,
 * Clear filters, KPIs, By project / By employee bars (tap toggles the filter), the
 * latest 40 entries and Download CSV (V-14).
 */
export function TeamTimesheet({ source, allProjects, projects, team, csvName, initialPeriod, initialProject = 'all', hint, hideFiltered, onProject }: TeamTimesheetProps) {
  const [per, setPer] = useState<Period>(initialPeriod);
  const [pf, setPfState] = useState(initialProject);
  const [ef, setEf] = useState('all');
  const L = useTimeLabels();
  const setPf = (x: string) => {
    setPfState(x);
    onProject?.(x);
  };
  const [r0, r1] = periodRange(per);
  const A = useMemo(() => inRange(source, r0, r1), [source, r0, r1]);
  const list = useMemo(() => newestFirst(filterTeam(A, pf, team ? ef : 'all')), [A, pf, ef, team]);
  const people = useMemo(() => [...new Set((hideFiltered ? A : source).map((e) => e.who))], [A, source, hideFiltered]);
  const b = billMin(list);
  const n = nonMin(list);
  const byP = totalsBy(list, (e) => e.proj);
  const byE = totalsBy(list, (e) => e.who);
  const maxP = Math.max(1, ...byP.map((x) => x.min));
  const maxE = Math.max(1, ...byE.map((x) => x.min));
  const download = async () => {
    const ok = await shareCsv(csvName, teamCsv(list, L.proj, L.key));
    if (!ok) showToast('Could not export the CSV');
  };
  return (
    <>
      <FilterChips
        options={[
          { value: 'week', label: 'This week' },
          { value: 'last', label: 'Last week' },
          { value: '30', label: 'Last 30 days' },
          { value: 'all', label: 'All time' },
        ]}
        value={per}
        onChange={(x) => setPer(x as Period)}
        testID="team-per"
      />
      <Form>
        <SelectField label="Project" value={pf} options={[{ value: 'all', label: allProjects }, ...projects]} onChange={setPf} testID="team-project" />
        {team ? (
          <SelectField label="Employee" value={ef} options={[{ value: 'all', label: 'All employees' }, ...people.map((p) => ({ value: p, label: p }))]} onChange={setEf} testID="team-employee" />
        ) : null}
      </Form>
      {pf !== 'all' || ef !== 'all' ? (
        <Button
          title="Clear filters"
          icon="x"
          kind="s"
          onPress={() => {
            setPf('all');
            setEf('all');
          }}
          testID="team-clear"
        />
      ) : null}
      <KpiGrid
        testID="team-kpis"
        items={[
          { label: 'Total', value: hm(b + n), sub: `${list.length} entries`, dot: colors.ink, testID: 'team-total' },
          { label: 'Billable', value: hm(b), sub: `${Math.round((b / Math.max(1, b + n)) * 100)}%`, dot: colors.primary },
          { label: 'Non-billable', value: hm(n), dot: colors.violet },
          { label: 'People', value: String(new Set(list.map((e) => e.who)).size), dot: colors.faint, testID: 'team-people' },
        ]}
      />
      {hideFiltered && pf !== 'all' ? null : (
        <Block title="By project" sub={hint}>
          <ProgressList
            testID="team-by-project"
            empty="No time logged for these filters."
            items={byP.map((x) => ({
              title: L.proj(x.key),
              used: x.min,
              of: maxP,
              value: hm(x.min),
              caption: 'Tap to filter',
              onPress: () => setPf(pf === x.key ? 'all' : x.key),
            }))}
          />
        </Block>
      )}
      {team && !(hideFiltered && ef !== 'all') ? (
        <Block title="By employee" sub={hint}>
          <ProgressList
            testID="team-by-employee"
            empty="No time logged for these filters."
            items={byE.map((x) => ({
              title: x.key,
              used: x.min,
              of: maxE,
              value: hm(x.min),
              caption: 'Tap to filter',
              onPress: () => setEf(ef === x.key ? 'all' : x.key),
            }))}
          />
        </Block>
      ) : null}
      <Block title="Entries" sub={list.length > 40 ? `Latest 40 of ${list.length}` : ''}>
        <Rows empty="No time logged for these filters." testID="team-entries">
          {list.slice(0, 40).map((e) => (
            <TeamEntryRow key={`${e.id}-${e.who}`} e={e} project={L.proj(e.proj)} />
          ))}
        </Rows>
      </Block>
      <Button title="Download CSV" icon="download" kind="s" onPress={download} testID="team-csv" />
    </>
  );
}
