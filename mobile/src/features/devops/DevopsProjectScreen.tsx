import { useState } from 'react';

import {
  Block,
  Button,
  CommentThread,
  EmptyBlock,
  FieldList,
  Hero,
  IconTile,
  ProjectTile,
  Row,
  Rows,
  Screen,
  Segmented,
  TextBlock,
  Timeline,
  showToast,
  type HeroChip,
  type TimelineItem,
} from '@/components';
import { DEVSTEPS, DVF, PRIORITY_DOT, type DevopsFieldKey } from '@/data/constants';
import { TODAY } from '@/data/clock';
import { dvDate, fmt, fmtL } from '@/data/format';
import { canDv, devopsByKey, questionsOf, requestsFor, type DevopsView } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { DevopsSettings, TicketPrio } from '@/data/types';
import { openSheet, type DevopsTab } from '@/nav/routes';
import { colors } from '@/theme';

import { QuestionRow } from '../client/rows';
import { devopsTone, ladderState, overdue } from './board';
import { DvFieldSheet, DvLogSheet, DvStatusSheet, DvTextSheet } from './DevopsSheets';
import { DeploymentsBlock, RequestRows } from './parts';

type SheetState = { kind: 'status' } | { kind: 'text' } | { kind: 'log' } | { kind: 'field'; f: DevopsFieldKey } | null;

const TABS: DevopsTab[] = ['status', 'details', 'deploys', 'requests', 'notes'];

/** S5-DVP DevOps project (`dvp/[key]?tab=`): hero, then Status · Details · Deploys · Requests · Notes. */
export function DevopsProjectScreen({ dvKey, tab: tab0 }: { dvKey: string; tab?: string }) {
  const d = useAppState((s) => devopsByKey(s, dvKey));
  const ce = useAppState(canDv);
  const reqs = useAppState((s) => requestsFor(s, dvKey));
  const [tab, setTab] = useState<DevopsTab>(TABS.includes(tab0 as DevopsTab) ? (tab0 as DevopsTab) : 'status');
  const [sheet, setSheet] = useState<SheetState>(null);
  const close = () => setSheet(null);

  if (!d) {
    return (
      <Screen title="DevOps" testID="screen-dvp">
        <EmptyBlock text="Project not found." />
      </Screen>
    );
  }
  const late = overdue(d);
  const open = reqs.filter((r) => r.status !== 'Done').length;
  const chips: HeroChip[] = [
    { text: `Dev · ${d.dev}`, dot: colors.primary, bg: colors.bg, color: colors.ink2 },
    { text: `Deploy · ${d.deploy}`, dot: d.deploy === 'Completed' ? colors.green : colors.amberDot, bg: colors.bg, color: colors.ink2 },
    { text: d.cicd ? 'CI/CD on' : 'CI/CD off', dot: d.cicd ? colors.green : colors.faint, bg: colors.bg, color: colors.ink2 },
    ...(late ? [{ text: 'Follow-up overdue', dot: colors.danger, bg: colors.redSoft, color: colors.redInk }] : []),
  ];

  return (
    <Screen title={d.name} sub={`${d.key} · ${d.company}`} testID="screen-dvp">
      <Hero
        variant={late ? 'overdue' : 'white'}
        lead={<ProjectTile id={d.projectId} size={46} radius={13} />}
        eyebrow={`${d.key} · ${d.company}`}
        title={d.name}
        sub={`Updated by ${d.updatedBy || 'Rahul'}`}
        status={{ label: d.infra, tone: devopsTone(d.infra) }}
        onStatus={ce ? () => setSheet({ kind: 'status' }) : undefined}
        chips={chips}
        testID="dvp-hero"
      />
      <Segmented
        options={[
          { value: 'status', label: 'Status' },
          { value: 'details', label: 'Details' },
          { value: 'deploys', label: 'Deploys' },
          { value: 'requests', label: 'Requests', count: open || undefined },
          { value: 'notes', label: 'Notes' },
        ]}
        value={tab}
        onChange={setTab}
        testID="dvp-tab"
      />
      {tab === 'status' ? <StatusTab d={d} ce={ce} open={setSheet} /> : null}
      {tab === 'details' ? <DetailsTab d={d} ce={ce} open={setSheet} /> : null}
      {tab === 'deploys' ? (
        <>
          <DeploymentsBlock d={d} />
          <TextBlock tone="info" text="You are always notified when this project goes live or is rolled back." />
        </>
      ) : null}
      {tab === 'requests' ? <RequestsTab d={d} /> : null}
      {tab === 'notes' ? <NotesTab d={d} ce={ce} /> : null}

      {sheet?.kind === 'status' ? <DvStatusSheet visible dvKey={d.key} onClose={close} /> : null}
      {sheet?.kind === 'text' ? <DvTextSheet visible dvKey={d.key} onClose={close} /> : null}
      {sheet?.kind === 'log' ? <DvLogSheet visible dvKey={d.key} onClose={close} /> : null}
      {sheet?.kind === 'field' ? <DvFieldSheet visible dvKey={d.key} field={sheet.f} onClose={close} /> : null}
    </Screen>
  );
}

interface TabProps {
  d: DevopsView;
  ce: boolean;
  open: (s: SheetState) => void;
}

/** Client ladder timeline (done green, current blue or red from `esc`, future grey). */
function ladderItems(d: DevopsView, S: DevopsSettings, ix: number): TimelineItem[] {
  const late = overdue(d);
  return S.ladder.map((x, i) => ({
    dot: i < ix ? colors.green : i === ix ? (i >= S.esc ? colors.danger : colors.primary) : colors.lineInput,
    ring: i === ix ? colors.primarySoft : colors.transparent,
    title: x.n,
    titleColor: i <= ix ? colors.ink : colors.ink3,
    sub: i === ix ? (d.reminder ? `Next reminder ${dvDate(d.reminder)}` : 'Current step') : i > ix ? `+${x.h}h after previous` : undefined,
    subColor: i === ix && late ? colors.danger : colors.ink3,
    right: i < ix ? 'Done' : undefined,
  }));
}

function StatusTab({ d, ce, open }: TabProps) {
  const S = useAppState((s) => s.devopsSettings);
  const { setDevPhase } = useActions();
  const { client, ix } = ladderState(d, S);
  const di = (DEVSTEPS as readonly string[]).indexOf(d.dev);
  const days = (n: string) => S.phases.find((p) => p.n === n)?.d ?? 0;
  const phases: TimelineItem[] = DEVSTEPS.map((n, i) => ({
    dot: i < di ? colors.green : i === di ? colors.primary : colors.lineInput,
    ring: i === di ? colors.primarySoft : colors.transparent,
    title: n,
    titleColor: i <= di ? colors.ink : colors.ink3,
    sub: i === di ? 'Current phase' : i === di + 1 ? 'Up next' : undefined,
    subColor: colors.primaryInk,
    right: i === di ? undefined : days(n) ? `~${days(n)} days` : undefined,
    onPress:
      ce && i !== di
        ? () => {
            const r = setDevPhase(d.key, n);
            if (!r.ok) showToast(r.error);
          }
        : undefined,
  }));
  const due = d.latestDue || d.initDue || '';
  return (
    <>
      <Block title="Next step" sub={d.owner ? `Owner · ${d.owner}` : undefined} action={ce ? 'Edit' : undefined} onAction={() => open({ kind: 'text' })} actionTestID="dvp-next-edit">
        <TextBlock text={d.next || d.phase || 'No next step written yet.'} testID="dvp-next" />
      </Block>
      {client ? (
        <Block
          title="Client follow-up"
          sub={`Fixed schedule · step ${ix + 1} of ${S.ladder.length}`}
          action={ce ? 'Log follow-up' : undefined}
          onAction={() => open({ kind: 'log' })}
          actionTestID="dvp-log"
          testID="dvp-ladder"
        >
          <Timeline items={ladderItems(d, S, ix)} />
        </Block>
      ) : d.ifu?.length ? (
        <Block title="Internal follow-up" sub="You set the date at each step" action={ce ? 'Log follow-up' : undefined} onAction={() => open({ kind: 'log' })} actionTestID="dvp-log" testID="dvp-ifu">
          <Timeline
            items={d.ifu.map((x) => ({
              dot: x.done ? colors.green : colors.primary,
              ring: x.done ? colors.transparent : colors.primarySoft,
              title: x.name,
              sub: x.note || (x.done ? undefined : `Due ${fmtL(x.date)}`),
              subColor: !x.done && x.date < TODAY ? colors.danger : colors.ink3,
              right: fmt(x.date),
            }))}
          />
        </Block>
      ) : (
        <Block title="Follow-ups" testID="dvp-no-followups">
          <EmptyBlock text="No follow-ups running. Set Action status to Waiting for client to start the sequence." />
        </Block>
      )}
      <Block title="Dev phase" sub="Tap a phase to make it current" testID="dvp-phases">
        <Timeline items={phases} />
      </Block>
      <Block title="Dates" sub="Initial due date is fixed once saved">
        <FieldList
          testID="dvp-dates"
          items={[
            { label: 'Initial due date', value: dvDate(d.initDue) },
            {
              label: 'Estimated deployment',
              value: dvDate(due),
              color: d.moved ? colors.destructiveInk : undefined,
              icon: 'pencil',
              onPress: ce ? () => open({ kind: 'field', f: 'latestDue' }) : undefined,
              testID: 'dvp-date-latestDue',
            },
            d.moved ? { label: 'Moved', value: `${d.moved}${d.reason ? ` · ${d.reason}` : ''}`, color: colors.destructiveInk, testID: 'dvp-date-moved' } : null,
            {
              label: 'Next reminder',
              value: dvDate(d.reminder),
              color: overdue(d) ? colors.danger : undefined,
              icon: 'pencil',
              onPress: ce ? () => open({ kind: 'field', f: 'reminder' }) : undefined,
              testID: 'dvp-date-reminder',
            },
          ]}
        />
      </Block>
    </>
  );
}

function DetailsTab({ d, ce, open }: TabProps) {
  const lockInitial = useAppState((s) => s.devopsSettings.rules.lockInitial);
  const { toggleCicd } = useActions();
  const rec = d as unknown as Record<string, string | undefined>;
  return (
    <>
      <Block title="Details" sub={ce ? 'Changes are logged automatically' : 'Read only'}>
        <FieldList
          testID="dvp-details"
          items={DVF.map((f) => {
            const raw = rec[f.key] ?? '';
            const locked = f.key === 'initDue' && !!d.initDue && lockInitial;
            return {
              label: f.label,
              value: f.options ? raw : dvDate(raw),
              dot: f.key === 'prio' && raw ? PRIORITY_DOT[raw as TicketPrio] : undefined,
              onPress: ce && !locked ? () => open({ kind: 'field', f: f.key }) : undefined,
              testID: `dvp-field-${f.key}`,
            };
          })}
        />
      </Block>
      <Block title="CI/CD">
        <Rows>
          <Row
            lead={<IconTile icon="git-branch" bg={d.cicd ? colors.greenSoft : colors.track} fg={d.cicd ? colors.greenInk : colors.ink2} />}
            title="CI/CD pipeline"
            sub={d.cicd ? 'On · each deploy reports to the timeline' : 'Off · deploys are not reported'}
            subWrap
            toggle={d.cicd}
            onPress={
              ce
                ? () => {
                    const r = toggleCicd(d.key);
                    if (!r.ok) showToast(r.error);
                  }
                : undefined
            }
            testID="dvp-cicd"
          />
        </Rows>
      </Block>
    </>
  );
}

function RequestsTab({ d }: { d: DevopsView }) {
  const reqs = useAppState((s) => requestsFor(s, d.key));
  const qs = useAppState((s) => questionsOf(s, d.projectId));
  return (
    <>
      <Button title="New request" icon="plus" onPress={() => openSheet('devops-request', { key: d.key })} testID="dvp-new-request" />
      <Block title="Requests" sub="Raised by project teams. Also shown on the web board.">
        <RequestRows requests={reqs} empty="No requests yet. Teams can raise requests from the project page." testID="dvp-requests" />
      </Block>
      {qs.length ? (
        <Block title="Client tickets" sub="Questions raised to the client">
          <Rows testID="dvp-client-questions">
            {qs.map((q) => (
              <QuestionRow key={q.id} q={q} />
            ))}
          </Rows>
        </Block>
      ) : null}
    </>
  );
}

function NotesTab({ d, ce }: { d: DevopsView; ce: boolean }) {
  const { addDevopsNote } = useActions();
  const logs: TimelineItem[] = d.logs.map((x) => ({ dot: colors.primary, ring: colors.primarySoft, title: x.text, sub: x.by, right: x.when }));
  return (
    <>
      <Block title="Notes">
        <CommentThread
          comments={d.notes.map((n) => ({ who: n.by, t: n.text, when: n.when }))}
          empty="No notes yet."
          placeholder="Add a note…"
          onSend={
            ce
              ? (t) => {
                  const r = addDevopsNote(d.key, t);
                  if (!r.ok) showToast(r.error);
                  return r.ok;
                }
              : undefined
          }
          testID="dvp-notes"
        />
      </Block>
      <Block title="Activity log" sub="Changes are logged automatically">
        <Timeline items={logs} empty="No updates yet." testID="dvp-log-list" />
      </Block>
    </>
  );
}
