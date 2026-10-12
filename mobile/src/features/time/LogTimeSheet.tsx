import { useState } from 'react';

import { IconTile, ProjectTile } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button, ButtonRow } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { DateField, Form, HoursMinutesField, TextArea, TextField, ToggleField } from '@/components/fields';
import { Row, Rows } from '@/components/Row';
import { Segmented } from '@/components/Segmented';
import { TextBlock } from '@/components/TextBlock';
import { showToast } from '@/components/Toast';
import { TODAY } from '@/data/clock';
import { entriesAll } from '@/data/selectors';
import { store, useActions, useAppState } from '@/data/store';
import { closeSheet, type SheetQuery } from '@/nav/routes';
import { colors } from '@/theme';

import { ADMIN_VALUE, logProjectOption, logProjectOptions, logTicketOptions, normalizeKey, type LogProjectOption } from './logOptions';

interface Form_ {
  id?: number;
  date: string;
  proj: string;
  mode: 'ticket' | 'text';
  key: string;
  text: string;
  h: string;
  m: string;
  bill: boolean;
  note: string;
}

/** The form for a preset (`openLog` params) or an entry being edited. */
function initialForm(q: SheetQuery<'log-time'>): Form_ {
  const s = store.getState();
  const id = q.id ? Number(q.id) : undefined;
  const e = id != null ? entriesAll(s).find((x) => x.id === id) : undefined;
  if (e) {
    return {
      id: e.id,
      date: e.date,
      proj: e.proj,
      mode: e.key ? 'ticket' : 'text',
      key: e.key,
      text: e.key ? '' : e.task,
      h: String(Math.floor(e.min / 60)),
      m: String(e.min % 60),
      bill: e.bill,
      note: e.note,
    };
  }
  const proj = q.proj ?? '';
  return {
    date: q.date || TODAY,
    proj,
    mode: q.text ? 'text' : 'ticket',
    key: normalizeKey(s, q.key),
    text: q.text ?? '',
    h: '',
    m: '',
    bill: proj !== ADMIN_VALUE,
    note: '',
  };
}

function ProjectLead({ o }: { o: LogProjectOption }) {
  if (o.kind === 'admin') return <IconTile icon="users-round" bg={colors.amberSoft} fg={colors.amberInk} />;
  if (o.kind === 'internal') return <IconTile icon="building-2" bg={colors.violetSoft} fg={colors.violetInk} />;
  return <ProjectTile id={o.id ?? ''} />;
}

/**
 * SH-LOG "Log your time" / "Edit time" (V-10, V-11, V-12): inline project picker,
 * date, Ticket / Text, ticket + subtask picker, h + min, Billable, notes, Delete in edit
 * mode. Errors in SPEC order come from `saveTimeEntry`.
 */
export function LogTimeSheet({ params }: { params: SheetQuery<'log-time'> }) {
  const [f, setF] = useState<Form_>(() => initialForm(params));
  const [dd, setDd] = useState<'' | 'proj' | 'tk'>('');
  const [err, setErr] = useState('');
  const [tried, setTried] = useState(false);
  const { saveTimeEntry, deleteTimeEntry } = useActions();
  const opts = useAppState((s) => logProjectOptions(s, f.proj));
  const cur = useAppState((s) => logProjectOption(s, f.proj));
  const tks = useAppState((s) => logTicketOptions(s, f.proj, f.key));
  const curT = tks.find((o) => o.value === f.key);
  const edit = f.id != null;
  const isAdmin = f.proj === ADMIN_VALUE;
  const tkOn = f.mode === 'ticket' && !isAdmin;
  const set = (patch: Partial<Form_>) => {
    setF((x) => ({ ...x, ...patch }));
    setErr('');
  };
  const pickProject = (v: string) => {
    set({ proj: v, key: '', bill: v !== ADMIN_VALUE });
    setDd('');
  };
  const save = () => {
    const r = saveTimeEntry({ id: f.id, date: f.date, proj: f.proj, mode: f.mode, key: f.key, text: f.text, h: f.h, m: f.m, bill: f.bill, note: f.note });
    if (!r.ok) {
      setErr(r.error);
      setTried(true);
      return;
    }
    closeSheet();
    showToast(r.toast);
  };
  const remove = () => {
    if (f.id == null) return;
    const r = deleteTimeEntry(f.id);
    closeSheet();
    showToast(r.ok ? r.toast : r.error);
  };
  const projOpt = (o: LogProjectOption) => (
    <Row
      key={o.value}
      lead={<ProjectLead o={o} />}
      title={o.title}
      sub={o.sub}
      picked={o.value === f.proj}
      bg={o.value === f.proj ? colors.rowPicked : undefined}
      onPress={() => pickProject(o.value)}
      testID={`log-proj-${o.value}`}
    />
  );
  const ticketHint = !f.proj ? 'Choose a project first' : tks.length ? 'Choose a ticket' : 'No tickets in this project. Switch to Text.';
  return (
    <BottomSheet title={edit ? 'Edit time' : 'Log your time'} testID="sheet-log-time">
      <Block title="Project *">
        <Rows>
          <Row
            lead={cur ? <ProjectLead o={cur} /> : undefined}
            title={cur ? cur.title : 'Choose a project'}
            titleColor={cur ? colors.ink : colors.ink3}
            sub={cur?.sub}
            bg={tried && !f.proj ? colors.errorBg : undefined}
            label={cur ? `Project: ${cur.title}` : 'Choose a project'}
            onPress={() => setDd(dd === 'proj' ? '' : 'proj')}
            testID="log-proj"
          />
        </Rows>
      </Block>
      {dd === 'proj' && opts.client.length ? (
        <Block title="Client projects">
          <Rows>{opts.client.map(projOpt)}</Rows>
        </Block>
      ) : null}
      {dd === 'proj' ? (
        <Block title="Internal">
          <Rows>{opts.internal.map(projOpt)}</Rows>
        </Block>
      ) : null}
      <DateField label="Date" value={f.date} onChange={(date) => set({ date })} testID="log-date" />
      {!isAdmin ? (
        <Block title="Log against">
          <Segmented
            options={[
              { value: 'ticket', label: 'Ticket' },
              { value: 'text', label: 'Text' },
            ]}
            value={f.mode}
            onChange={(mode) => set({ mode })}
            testID="log-mode"
          />
        </Block>
      ) : null}
      {tkOn ? (
        <Block title="Ticket">
          <Rows>
            <Row
              lead={<IconTile icon="ticket" bg={colors.primarySoft} fg={colors.primaryInk} />}
              monoKey={curT?.k}
              title={curT ? curT.title : ticketHint}
              titleColor={curT ? colors.ink : colors.ink3}
              sub={curT?.sub}
              bg={tried && !f.key && tks.length ? colors.errorBg : undefined}
              chevron={false}
              label={curT ? `Ticket: ${curT.k}` : ticketHint}
              onPress={f.proj && tks.length ? () => setDd(dd === 'tk' ? '' : 'tk') : undefined}
              testID="log-ticket"
            />
          </Rows>
        </Block>
      ) : null}
      {tkOn && dd === 'tk' ? (
        <Rows testID="log-ticket-list">
          {tks.map((o) => (
            <Row
              key={o.value}
              monoKey={o.k}
              title={o.title}
              sub={o.sub}
              picked={o.value === f.key}
              bg={o.value === f.key ? colors.rowPicked : undefined}
              label={`${o.k} ${o.title}`}
              onPress={() => {
                set({ key: o.value });
                setDd('');
              }}
              testID={`log-tk-${o.k}`}
            />
          ))}
        </Rows>
      ) : null}
      <Form>
        {tkOn ? null : (
          <TextField label="What did you work on?" value={f.text} onChange={(text) => set({ text })} placeholder="e.g. Client call, code review" testID="log-text" />
        )}
        <HoursMinutesField
          label="Time spent"
          required
          h={f.h}
          m={f.m}
          onChange={(h, m) => set({ h, m })}
          error={tried && !(Number(f.h) || Number(f.m)) ? 'Add the time spent' : undefined}
          testID="log-time"
        />
        <ToggleField title={f.bill ? 'Billable' : 'Non-billable'} sub="Billable time is charged to the client" value={f.bill} onChange={(bill) => set({ bill })} testID="log-bill" />
        <TextArea label="Notes" optional value={f.note} onChange={(note) => set({ note })} placeholder="Anything worth remembering" testID="log-note" />
      </Form>
      {err ? <TextBlock tone="bad" text={err} testID="log-error" /> : null}
      <ButtonRow>
        {edit ? <Button title="Delete" icon="trash-2" kind="d" onPress={remove} testID="log-delete" /> : null}
        <Button title={edit ? 'Save' : 'Save time'} onPress={save} testID="log-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
