import { useState } from 'react';

import { Block, Button, ButtonRow, IconTile, ProgressList, Row, Rows, TicketRow } from '@/components';
import { fmt } from '@/data/format';
import { epicsOf, myPerm, sprintsOf, ticketsOf, type ProjectView } from '@/data/selectors';
import { useAppState, useStoreState } from '@/data/store';
import type { SprintState } from '@/data/types';
import { tones, type ToneName } from '@/theme';

import { MoveSprintSheet, NewEpicSheet, NewSprintSheet, SprintSheet } from '../sheets/SprintSheets';

const SPRINT_LOOK: Record<SprintState, { label: string; tone: ToneName; icon: 'circle-check' | 'play' | 'calendar' }> = {
  done: { label: 'Completed', tone: 'green', icon: 'circle-check' },
  active: { label: 'Active', tone: 'blue', icon: 'play' },
  planned: { label: 'Planned', tone: 'grey', icon: 'calendar' },
};

type Open = { kind: 'new'; epic: string } | { kind: 'sprint'; id: string } | { kind: 'move'; key: string; epic: string } | { kind: 'epic' } | null;

/** Epics & sprints tab (V-46…V-49, staff). `sprints.manage` gates + Sprint, Start/Complete and New epic. */
export function SprintsTab({ p }: { p: ProjectView }) {
  const state = useStoreState();
  const canS = useAppState((s) => myPerm(s, 'sprints.manage'));
  const [open, setOpen] = useState<Open>(null);
  const T = ticketsOf(state, p.id);
  const close = () => setOpen(null);
  return (
    <>
      {epicsOf(state, p.id).map((e) => {
        const ET = T.filter((t) => t.epicId === e.id);
        const done = ET.filter((t) => t.st === 'done').length;
        const SP = sprintsOf(state, e.id);
        const BL = ET.filter((t) => !t.sprintId && t.st !== 'done');
        return [
          <Block
            key={`${e.id}-head`}
            title={e.name}
            sub={e.state === 'planned' ? 'Planned' : 'Epic'}
            action={canS ? '+ Sprint' : undefined}
            onAction={canS ? () => setOpen({ kind: 'new', epic: e.id }) : undefined}
            actionTestID={`add-sprint-${e.id}`}
            testID={`epic-${e.id}`}
          >
            <ProgressList items={[{ title: e.name, used: done, of: ET.length || 1, caption: `${done} of ${ET.length} tasks done · ${SP.length} sprints`, color: tones.green.dot }]} />
          </Block>,
          <Rows key={`${e.id}-sprints`} empty="No sprints in this view." testID={`sprints-${e.id}`}>
            {SP.map((s) => {
              const look = SPRINT_LOOK[s.state];
              const n = ET.filter((t) => t.sprintId === s.id);
              const nd = n.filter((t) => t.st === 'done').length;
              return (
                <Row
                  key={s.id}
                  lead={<IconTile icon={look.icon} bg={tones[look.tone].soft} fg={tones[look.tone].ink} />}
                  title={s.name}
                  sub={`${fmt(s.start)} – ${fmt(s.end)} · ${nd} of ${n.length} done`}
                  badge={{ label: look.label, tone: look.tone }}
                  onPress={() => setOpen({ kind: 'sprint', id: s.id })}
                  testID={`sprint-row-${s.id}`}
                />
              );
            })}
          </Rows>,
          BL.length ? (
            <Block key={`${e.id}-backlog`} title="Backlog" sub={`${BL.length} tasks · ${e.name}`}>
              <Rows testID={`backlog-${e.id}`}>
                {BL.map((t) => (
                  <TicketRow
                    key={t.key}
                    ticket={t}
                    sub={`Backlog · ${t.est || 0}h estimate`}
                    row={{ badge: { label: 'Move to…', tone: 'blue' }, label: `Move ${t.key} to a sprint` }}
                    onPress={() => setOpen({ kind: 'move', key: t.key, epic: e.id })}
                    testID={`backlog-row-${t.key}`}
                  />
                ))}
              </Rows>
            </Block>
          ) : null,
        ];
      })}
      {canS ? (
        <ButtonRow>
          <Button title="New epic" kind="s" icon="plus" onPress={() => setOpen({ kind: 'epic' })} testID="new-epic" />
        </ButtonRow>
      ) : null}
      {open?.kind === 'new' ? <NewSprintSheet epicId={open.epic} onClose={close} /> : null}
      {open?.kind === 'sprint' ? <SprintSheet sprintId={open.id} onClose={close} /> : null}
      {open?.kind === 'move' ? <MoveSprintSheet ticketKey={open.key} epicId={open.epic} onClose={close} /> : null}
      {open?.kind === 'epic' ? <NewEpicSheet projectId={p.id} onClose={close} /> : null}
    </>
  );
}
