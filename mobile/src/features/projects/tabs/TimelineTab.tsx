import { useMemo } from 'react';

import { Block, EmptyBlock, Gantt, openTicket } from '@/components';
import { fmt } from '@/data/format';
import { dueInfo, type ProjectView } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { colors } from '@/theme';

import { ganttRange, projectSpans, taskStart } from '../derive';
import type { Jump } from './types';

/** Timeline tab: sprint and task Gantts on one range with the today line. */
export function TimelineTab({ p, jump }: { p: ProjectView; jump: Jump }) {
  const state = useStoreState();
  const { sprints, tasks, spans } = useMemo(() => projectSpans(state, p.id), [state, p.id]);
  const r = ganttRange(spans);
  if (!r) return <EmptyBlock text="No dates planned yet." testID="timeline-empty" />;
  const bar = (a: string, b: string) => ({ left: r.pos(a), width: Math.max(2, r.pos(b) - r.pos(a)) });
  return (
    <>
      <Block title="Sprints" sub="Line marks today">
        <Gantt
          ticks={r.ticks}
          now={r.now}
          empty="No sprints planned yet."
          items={sprints.map((s) => ({
            title: `${s.epicName} · ${s.name}`,
            right: `${fmt(s.start)} – ${fmt(s.end)}`,
            ...bar(s.start, s.end),
            color: s.state === 'done' ? colors.green : s.state === 'active' ? colors.primary : colors.faint,
            onPress: () => jump('board'),
          }))}
          testID="gantt-sprints"
        />
      </Block>
      <Block title="Tasks">
        <Gantt
          ticks={r.ticks}
          now={r.now}
          empty="No task dates yet."
          items={tasks.map((t) => {
            const d = dueInfo(t);
            return {
              title: `${t.key} · ${t.title}`,
              right: d.text,
              rightColor: d.color,
              ...bar(taskStart(t), t.due!),
              color: t.st === 'done' ? colors.green : d.late ? colors.red : colors.primary,
              onPress: () => openTicket(t.key),
            };
          })}
          testID="gantt-tasks"
        />
      </Block>
    </>
  );
}
