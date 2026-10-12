import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  Avatar,
  Badge,
  Block,
  Board,
  BottomSheet,
  BrandMark,
  Button,
  ButtonRow,
  CommentThread,
  CompanyTile,
  ConfirmSheet,
  DateField,
  DayStrip,
  EmptyBlock,
  FieldList,
  FileField,
  FilterChips,
  Form,
  Gantt,
  Header,
  HeatTable,
  Hero,
  HoursMinutesField,
  IconTile,
  KpiGrid,
  MonoKey,
  PickField,
  PickList,
  PriorityDot,
  ProgressList,
  ProjectTile,
  RoleBadge,
  Row,
  Rows,
  SearchField,
  Segmented,
  SelectField,
  showToast,
  StepBars,
  TextArea,
  TextBlock,
  TextField,
  TextTile,
  TicketRow,
  Timeline,
  ToggleField,
  Txt,
  TypeTag,
  WeekBars,
  type PickedFile,
} from '@/components';
import { PRIORITY_DOT, TICKET_STATUS } from '@/data/constants';
import type { TicketStatus } from '@/data/types';
import { dueInfo } from '@/data/selectors';
import { createInitialState } from '@/data/store';
import { colors, tones } from '@/theme';

const seed = createInitialState();
const ticket = seed.tickets.find((t) => t.key === 'PMT-11')!;

/**
 * Dev gallery of every v5 block (DELTA §4), checked against mobile-spec-v5/screenshots.
 * Open /dev/kitchen-sink (signed in or not).
 */
export default function KitchenSink() {
  const [seg, setSeg] = useState('log');
  const [chip, setChip] = useState('all');
  const [q, setQ] = useState('');
  const [day, setDay] = useState('2026-10-10');
  const [text, setText] = useState('');
  const [sel, setSel] = useState('Norway');
  const [date, setDate] = useState('2026-10-10');
  const [pick, setPick] = useState<'Task' | 'Story' | 'Bug'>('Task');
  const [multi, setMulti] = useState<string[]>(['Chary']);
  const [tog, setTog] = useState(true);
  const [h, setH] = useState('1');
  const [m, setM] = useState('30');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [sheet, setSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [picked, setPicked] = useState<TicketStatus>('prog');
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} testID="kitchen-sink">
      <Header title="Dashboard" sub="Everything across Viljetech" root actions={[{ icon: 'search', label: 'Search', onPress: () => showToast('Search') }]} />
      <Header title="PMT-11" sub="Daco platform" actions={[{ icon: 'plus', label: 'Create ticket', onPress: () => showToast('Plus') }]} />

      <Block title="Hero" sub="white · dark · teal · overdue">
        <Hero
          lead={<ProjectTile id="dacop" size={46} radius={13} />}
          eyebrow="PMT-11 · Task"
          title="Push notifications setup"
          sub="Daco platform · Mobile app"
          status={{ label: 'In progress', tone: 'blue' }}
          onStatus={() => showToast('Status')}
          chips={[
            { text: 'Critical', dot: PRIORITY_DOT.Critical },
            { text: 'Due 7 Oct', dot: colors.danger, bg: colors.redSoft, color: colors.danger },
          ]}
          bar={{ pct: 22, label: '22% done' }}
        />
        <Hero variant="dark" lead={<CompanyTile name="Daco" size={46} radius={13} />} eyebrow="Client portal" title="Daco" sub="What Daco sees when they sign in" />
        <Hero
          variant="teal"
          lead={<ProjectTile id="fjp" size={46} radius={13} />}
          eyebrow="Maintenance · Fjordline Logistics"
          title="Driver app"
          sub="Live since 30 Aug"
          status={{ label: 'Maintenance', bg: 'rgba(255,255,255,0.14)', ink: colors.white, dot: colors.uptime }}
          chips={[{ text: 'Up · 99.98% uptime', dot: colors.uptime }, { text: 'Support until 30 Aug' }]}
        />
        <Hero variant="overdue" lead={<ProjectTile id="welop" size={46} radius={13} />} eyebrow="OPS-103 · Weland" title="Order portal" sub="Updated by Rahul" status={{ label: 'Client onboarding', tone: 'amber' }} />
      </Block>

      <Block title="Search, segmented, chips, day strip">
        <SearchField value={q} onChange={setQ} placeholder="Search projects" />
        <Segmented
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'log', label: 'Log' },
            { value: 'week', label: 'Week' },
            { value: 'history', label: 'History', count: 3 },
          ]}
        />
        <FilterChips
          value={chip}
          onChange={setChip}
          options={[
            { value: 'all', label: 'All', count: 8 },
            { value: 'active', label: 'Active', count: 5 },
            { value: 'planned', label: 'Planned', count: 2 },
            { value: 'maint', label: 'Maintenance', count: 1 },
          ]}
        />
        <DayStrip
          selected={day}
          onSelect={setDay}
          days={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({
            date: `2026-10-${String(5 + i).padStart(2, '0')}`,
            day: d,
            num: String(5 + i),
            hours: i < 5 ? '7h 30m' : '–',
            short: i === 2,
            today: i === 5,
          }))}
        />
      </Block>

      <Block title="KPI grid">
        <KpiGrid
          items={[
            { label: 'Active projects', value: '8', sub: '4 companies' },
            { label: 'Logged this month', value: '612h', of: '/ 704h', sub: '87% of working hours', dot: colors.ink },
            { label: 'Idle time', value: '92h', sub: '13% of working hours', dot: colors.red },
            { label: 'Critical open', value: '2', sub: '1 overdue', dot: colors.danger, color: colors.danger },
          ]}
        />
      </Block>

      <Block title="Rows" sub="every slot" action="Projects ›" onAction={() => showToast('Action')}>
        <Rows>
          <TicketRow ticket={ticket} />
          <Row lead={<Avatar name="Chary" />} title="Chary" sub="chary@viljetech.com · Mobile" badge={{ label: 'Developer', tone: 'green', dot: false }} right="Today" onPress={() => showToast('Row')} />
          <Row lead={<ProjectTile id="nordp" />} title="Business portal" sub="Nordlys Energi" badge={{ label: 'Active', tone: 'blue' }} bar={{ pct: 41, label: '41%' }} meta={[{ icon: 'flag', text: 'Deadline passed 8 Oct', color: colors.danger, bold: true }, { icon: 'users', text: '2' }]} onPress={() => showToast('Project')} />
          <Row check={{ on: true, label: 'Done', onToggle: () => showToast('Check') }} monoKey="PMT-11.1" title="iOS push certificates" strike titleColor={colors.ink3} meta={[{ text: 'Done' }]} />
          <Row lead={<IconTile icon="layers" bg={colors.violetSoft} fg={colors.violetInk} />} title="Over budget" bar={{ pct: 118, label: '118%', labelColor: colors.danger }} />
          <Row title="Ticket assigned to me" sub="When someone assigns or mentions you" toggle={tog} onPress={() => setTog(!tog)} />
          <Row title="In progress" dot={tones.blue.dot} picked onPress={() => showToast('Pick')} />
          <Row lead={<TextTile text="IS" />} title="Inactive" sub="Deactivated" opacity={0.6} right="Deactivated" rightColor={colors.danger} />
        </Rows>
        <Rows empty="No projects match these filters." />
      </Block>

      <Block title="Bits">
        <View style={styles.wrap}>
          <Badge label="In progress" tone="blue" />
          <Badge label="Overdue" tone="red" />
          <RoleBadge role="cadmin" />
          <PriorityDot prio="High" />
          <TypeTag type="Bug" />
          <TypeTag type="Story" />
          <MonoKey k="OPS-106" />
          <Avatar name="Sofia" size={32} />
          <Avatar name="Ingrid Solberg" size={32} />
          <CompanyTile name="Weland" size={32} />
          <BrandMark size={32} />
        </View>
      </Block>

      <Block title="Progress list">
        <ProgressList
          items={[
            { title: 'Daco · Daco platform', used: 342, of: 400, caption: '342h of 400h · 58h left' },
            { title: 'Daco · Intranet', used: 188, of: 160, caption: '188h of 160h · 28h over budget' },
            { title: 'Nordlys · Business portal', used: 96, of: 240, caption: '96h of 240h' },
          ]}
        />
      </Block>

      <Block title="Week bars">
        <WeekBars
          foot="31h logged"
          days={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => ({ day: d, billMin: i < 5 ? 300 - i * 20 : 0, nonMin: i < 5 ? 60 : 0, idleMin: i < 5 ? 120 + i * 20 - 60 : 0 }))}
        />
      </Block>

      <Block title="Step bars">
        <StepBars
          rows={[
            { title: 'Daco platform', status: 'Not started', tone: 'grey', steps: ['current', 'future', 'future', 'future'] },
            { title: 'Fast', status: 'Prod product deployment', tone: 'violet', steps: ['done', 'done', 'current', 'future'] },
          ]}
        />
      </Block>

      <Block title="Heat table">
        <HeatTable
          rows={[
            { title: 'Daco platform', sub: 'Login with BankID', cells: [180, 240, 0, 0, 0, 0, 0] },
            { title: 'Admin & meetings', sub: 'Weekly planning', cells: [60, 0, 0, 0, 90, 0, 0] },
          ]}
        />
      </Block>

      <Block title="Timeline">
        <Timeline
          items={[
            { k: '2.6.1', title: 'Ticket import and BankID login', right: 'Today, 10:20', dot: colors.green, ring: colors.greenSoft, kColor: colors.greenInk },
            { k: '2.5.3', title: 'Profile settings · rolled back', sub: 'Rolled back to 2.5.2', subColor: colors.dangerInk, right: '8 Oct, 16:40', dot: colors.danger, ring: colors.redSoft, kColor: colors.dangerInk },
            { title: 'Reminder 2', sub: '+72h after previous', dot: colors.faint },
          ]}
        />
      </Block>

      <Block title="Gantt">
        <Gantt
          ticks={['21 Sep', '5 Oct', '19 Oct', '1 Nov']}
          now={48}
          items={[
            { title: 'Sprint 1', right: '21 Sep – 4 Oct', left: 0, width: 34, color: colors.green },
            { title: 'Sprint 2', right: '5 Oct – 18 Oct', left: 34, width: 34, color: colors.primary },
            { title: 'Sprint 3', right: '19 Oct – 1 Nov', left: 68, width: 32, color: colors.faint },
          ]}
        />
      </Block>

      <Block title="Board">
        <Board
          columns={(['todo', 'prog', 'review', 'done'] as const).map((st) => ({
            key: st,
            name: TICKET_STATUS[st].label,
            dot: tones[TICKET_STATUS[st].tone].dot,
            cards: seed.tickets
              .filter((t) => t.projectId === 'dacop' && t.epicId === 'mob' && t.st === st)
              .map((t) => ({ k: t.key, title: t.title, prio: t.prio, type: t.type, due: dueInfo(t).text, dueColor: dueInfo(t).color, subs: t.subs.length ? `${t.subs.filter((x) => x.st === 'done').length}/${t.subs.length}` : undefined, comments: t.comments.length, people: t.as })),
          }))}
        />
      </Block>

      <Block title="Field list">
        <FieldList
          items={[
            { label: 'Status', value: 'In progress', dot: tones.blue.dot, onPress: () => showToast('Status') },
            { label: 'Due date', value: 'Wed 7 Oct', color: colors.danger, onPress: () => showToast('Due') },
            { label: 'Estimated deployment', value: '20 Nov 2026', icon: 'pencil', onPress: () => showToast('Date') },
            { label: 'Logged', value: '9h of 6h', color: colors.danger },
            { label: 'Sprint', value: '' },
          ]}
        />
      </Block>

      <Block title="Text">
        <TextBlock text="Plain text block, pre-wrap." />
        <TextBlock text="Waiting for the client to answer." tone="note" />
        <TextBlock text="Search pages, tickets, projects, companies and people." tone="info" />
        <TextBlock text="Pick a project first" tone="bad" />
        <TextBlock text="Use the new version, we will send it this week." tone="good" />
      </Block>

      <Block title="Form">
        <Form>
          <TextField label="Project name" required value={text} onChange={setText} placeholder="e.g. Customer app" error={text ? undefined : 'Required'} />
          <TextField label="Email" readOnly value="rahul@viljetech.com" />
          <TextArea label="What are we building?" optional value={text} onChange={setText} />
          <SelectField label="Country" value={sel} onChange={setSel} options={['Norway', 'Sweden', 'Denmark'].map((v) => ({ value: v, label: v }))} />
          <DateField label="Deadline" optional value={date} onChange={setDate} />
          <PickField label="Type" options={(['Task', 'Story', 'Bug'] as const).map((v) => ({ value: v, label: v }))} value={pick} onChange={setPick} />
          <PickField label="Team" multi optional options={['Rahul', 'Chary', 'Sofia'].map((v) => ({ value: v, label: v }))} values={multi} onChange={setMulti} />
          <ToggleField title={tog ? 'Billable' : 'Non-billable'} sub="Billable time is charged to the client" value={tog} onChange={setTog} />
          <HoursMinutesField label="Time spent" required h={h} m={m} onChange={(a, b) => (setH(a), setM(b))} />
          <FileField label="Photos & files" optional title="Add a screenshot" sub="PNG, JPG or PDF" value={file} onPick={setFile} />
        </Form>
      </Block>

      <Block title="Buttons">
        <ButtonRow>
          <Button title="Save time" />
          <Button title="Cancel" kind="s" />
        </ButtonRow>
        <ButtonRow>
          <Button title="Delete" kind="d" icon="trash-2" />
          <Button title="Approve" kind="g" icon="check" />
          <Button title="Ink" kind="ink" />
        </ButtonRow>
      </Block>

      <Block title="Comments">
        <CommentThread comments={ticket.comments} onSend={(t) => (showToast(`Sent: ${t}`), true)} />
      </Block>

      <Block title="Pick list">
        <PickList
          value={picked}
          onPick={setPicked}
          options={(['todo', 'prog', 'review', 'done'] as const).map((k) => ({ value: k, label: TICKET_STATUS[k].label, dot: tones[TICKET_STATUS[k].tone].dot }))}
        />
      </Block>

      <Block title="Empty">
        <EmptyBlock text="Nothing logged for this day yet." />
      </Block>

      <Block title="Sheets and toast">
        <ButtonRow>
          <Button title="Inline sheet" kind="s" onPress={() => setSheet(true)} testID="ks-open-sheet" />
          <Button title="Confirm" kind="d" onPress={() => setConfirm(true)} />
          <Button title="Toast" kind="ink" onPress={() => showToast('1h 30m logged')} />
        </ButtonRow>
      </Block>
      <Txt v="sub" color={colors.ink3}>
        End of kitchen sink
      </Txt>

      <BottomSheet visible={sheet} onClose={() => setSheet(false)} title="Status" sub="PMT-11" testID="ks-sheet">
        <PickList
          value={picked}
          onPick={(v) => {
            setPicked(v);
            setSheet(false);
            showToast(`Moved to ${TICKET_STATUS[v].label}`);
          }}
          options={(['todo', 'prog', 'review', 'done'] as const).map((k) => ({ value: k, label: TICKET_STATUS[k].label, dot: tones[TICKET_STATUS[k].tone].dot }))}
        />
      </BottomSheet>
      <ConfirmSheet
        visible={confirm}
        onClose={() => setConfirm(false)}
        title="Delete PMT-11.2?"
        text="“Android token refresh” is removed from PMT-11. Logged time is kept."
        confirm="Delete"
        onConfirm={() => showToast('Subtask deleted')}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 18, paddingBottom: 60 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
});
