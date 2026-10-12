import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  ApproveButton,
  Avatar,
  AvatarStack,
  Card,
  ChatBubble,
  Chip,
  ChipRow,
  CompanyLogo,
  Composer,
  CountBadge,
  CriticalBadge,
  DarkButton,
  DateField,
  DestructiveButton,
  EmptyState,
  Eyebrow,
  FactTile,
  Field,
  FieldError,
  IconTile,
  KeyChip,
  KpiTile,
  ListCard,
  ListRow,
  PrimaryButton,
  PriorityGlyph,
  ProgressBar,
  ProgressRing,
  SecondaryButton,
  Section,
  SegmentedControl,
  SelectField,
  showToast,
  SoftPillButton,
  StackedBar,
  StatusPill,
  Stepper,
  TextArea,
  TextField,
  TicketCard,
  Toggle,
  Txt,
  TypeIcon,
} from '@/components';
import { PROJECT_STATUS, TICKET_STATUS } from '@/data/constants';
import { useAppState } from '@/data/store';
import { colors, motion } from '@/theme';

/** Dev-only gallery of the shared components (open /dev/kitchen-sink). */
export default function KitchenSink() {
  const tickets = useAppState((s) => s.tickets);
  const [seg, setSeg] = useState<'open' | 'done' | 'all'>('open');
  const [chip, setChip] = useState<'all' | 'bill' | 'non'>('all');
  const [on, setOn] = useState(true);
  const [n, setN] = useState(10);
  const [sel, setSel] = useState('');
  const [date, setDate] = useState('2026-10-17');
  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={styles.page}>
      <Section title="Atoms" count={12}>
        <View style={styles.row}>
          <Avatar name="Chary" />
          <Avatar name="Ingrid Solberg" />
          <AvatarStack names={['Rahul', 'Chary', 'Arjun']} />
          <CompanyLogo company="Daco" />
          <CompanyLogo company="Havbruk AS" />
          <CompanyLogo company="Unknown Co" />
        </View>
        <View style={styles.row}>
          <KeyChip k="PMT-11" />
          <TypeIcon type="Bug" />
          <TypeIcon type="Task" />
          <TypeIcon type="Story" />
          <CriticalBadge />
          <PriorityGlyph prio="Urgent" />
          <PriorityGlyph prio="Low" />
          <CountBadge n={6} />
        </View>
        <View style={styles.row}>
          <StatusPill label={PROJECT_STATUS.maint.label} tone={PROJECT_STATUS.maint} />
          <StatusPill label={TICKET_STATUS.review.client} tone={TICKET_STATUS.review} size="md" chevron />
          <Chip label="Billable" bg={colors.primarySoft2} fg={colors.primaryInk} />
          <IconTile icon="siren" bg={colors.dangerSoft} fg={colors.danger} anim={motion.twinkle()} />
        </View>
      </Section>
      <Section title="Data">
        <View style={styles.row}>
          <KpiTile label="Critical" value="2" sub="Fix these first" icon="siren" accent={colors.danger} accentSoft={colors.dangerSoft} valueColor={colors.danger} iconAnim={motion.twinkle()} />
          <KpiTile label="Logged this week" value="29h" sub="of 40h" icon="timer" accent={colors.green} accentSoft={colors.greenSoft} index={1} />
        </View>
        <ProgressBar pct={42} />
        <StackedBar scale={40} height={10} gap={2} segments={[{ value: 26.5, color: colors.primary }, { value: 2.5, color: colors.nonBillable }, { value: 3, color: colors.idle }]} />
        <View style={styles.row}>
          <ProgressRing pct={68}>
            <Txt v="small">68%</Txt>
          </ProgressRing>
          <FactTile label="Due" locked value="7 Oct" valueColor={colors.danger} sub="3d late" subColor={colors.danger} />
          <FactTile label="Hours" value="9h" sub="3h over" onPlus={() => showToast('Plus')} />
        </View>
      </Section>
      <Section title="Controls">
        <SegmentedControl label="Filter" value={seg} onChange={setSeg} segments={[{ key: 'open', label: 'Open', count: 6 }, { key: 'done', label: 'Done', count: 1 }, { key: 'all', label: 'All', count: 7 }]} />
        <SegmentedControl label="Views" variant="icon" value="list" onChange={() => {}} segments={[{ key: 'list', label: 'List', icon: 'list' }, { key: 'board', label: 'Board', icon: 'square-kanban' }, { key: 'tree', label: 'Epics', icon: 'git-fork' }]} />
        <ChipRow label="Type" value={chip} onChange={setChip} options={[{ key: 'all', label: 'All' }, { key: 'bill', label: 'Billable' }, { key: 'non', label: 'Non-billable' }]} />
        <View style={styles.row}>
          <Toggle label="Push" value={on} onChange={setOn} />
          <Stepper label="Hours" value={n} onChange={setN} min={1} unit="hours" />
        </View>
        <PrimaryButton label="Sign in" onPress={() => showToast('PMT-22 moved to In progress')} />
        <DarkButton label="Download CSV" icon="download" onPress={() => {}} />
        <SecondaryButton label="Request a change" onPress={() => {}} />
        <DestructiveButton label="Sign out" onPress={() => {}} />
        <View style={styles.row}>
          <ApproveButton label="Approve" onPress={() => {}} />
          <SoftPillButton label="Mark all read" onPress={() => {}} />
        </View>
        <Field label="Project" required>
          <SelectField label="Project" value={sel} onChange={setSel} highlight options={[{ value: '', label: 'Choose a project' }, { value: 'Daco platform', label: 'Daco platform' }]} />
        </Field>
        <Field label="What did you work on?" required>
          <TextField label="Work" placeholder="e.g. Sprint planning" />
        </Field>
        <Field label="Note">
          <TextArea label="Note" placeholder="Optional" />
        </Field>
        <Field label="From">
          <DateField label="From" value={date} onChange={setDate} />
        </Field>
        <FieldError text="Pick the hours or minutes you worked." />
      </Section>
      <Section title="Lists">
        <Eyebrow>Account</Eyebrow>
        <ListCard>
          <ListRow first title="Switch account" sub="Try another role" icon="repeat-2" onPress={() => {}} />
          <ListRow title="Push notifications" sub="On" icon="bell" trailing={<Toggle label="Push" value={on} onChange={setOn} />} />
        </ListCard>
        <EmptyState text="Nothing here." />
        {tickets.slice(0, 2).map((t) => (
          <TicketCard key={t.id} ticket={t} />
        ))}
        <TicketCard ticket={tickets[8]} variant="compact" />
      </Section>
      <Section title="Chat">
        <Card style={{ gap: 10 }}>
          <ChatBubble who="Vivek" text="Can we pair on it today?" when="2h ago" />
          <ChatBubble who="Ingrid Solberg" text="Happens every time." when="Yesterday" fromClient />
          <ChatBubble who="Chary" text="Yes." when="just now" mine att={['photo-1.jpg']} />
        </Card>
        <Composer placeholder="Write a comment…" onSend={(t) => showToast(`Sent: ${t || 'photo'}`)} />
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 24, paddingBottom: 80 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
});
