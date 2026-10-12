/** Project List, Board, Epics tree, Timeline and Files views (S-PROJECT). */
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Dot, EmptyState, Icon, IconTile, Press, Txt } from '@/components';
import { SPRINT_STATE } from '@/data/constants';
import { TICKET_STATUS } from '@/data/constants';
import { useActions, useAppState } from '@/data/store';
import { toTicket } from '@/nav/routes';
import { colors, motion, radii, useLoop } from '@/theme';

import { epicsTree, type TreeEpic, type TreeSprint } from '../epicsTree';
import { ProjectTicketCard, ViewIn } from '../parts';
import { projectFiles, statusGroups } from '../selectors';
import { timeline } from '../timeline';

export function ListView({ project }: { project: string }) {
  const groups = useAppState((s) => statusGroups(s, project)).filter((g) => g.tickets.length);
  return (
    <ViewIn gap={16}>
      {!groups.length ? <EmptyState icon="inbox" text="No tickets yet." /> : null}
      {groups.map((g) => (
        <View key={g.status} testID={`group-${g.status}`}>
          <View style={styles.groupHead}>
            <Dot color={g.dot} size={8} />
            <Txt v="rowTitle" w={800}>
              {g.label}
            </Txt>
            <Txt v="meta" w={700} color={colors.ink3}>
              {String(g.tickets.length)}
            </Txt>
          </View>
          <View style={styles.cards}>
            {g.tickets.map((t) => (
              <ProjectTicketCard key={t.id} ticket={t} />
            ))}
          </View>
        </View>
      ))}
    </ViewIn>
  );
}

export function BoardView({ project }: { project: string }) {
  const groups = useAppState((s) => statusGroups(s, project));
  return (
    <Animated.View style={[styles.bleed, motion.fadeUp(0, 0, 0, 0.3)]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={290}
        decelerationRate="fast"
        contentContainerStyle={styles.boardRow}
        testID="project-board"
      >
        {groups.map((g) => (
          <View key={g.status} style={styles.col} testID={`column-${g.status}`}>
            <View style={styles.colHead}>
              <Dot color={g.dot} size={8} />
              <Txt v="body" w={800}>
                {g.label}
              </Txt>
              <Txt v="meta" w={700} color={colors.ink3}>
                {String(g.tickets.length)}
              </Txt>
            </View>
            <View style={styles.cards}>
              {g.tickets.map((t) => (
                <ProjectTicketCard key={t.id} ticket={t} />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

// ── Epics tree (M-26) ───────────────────────────────────────────────────────

export function EpicsView({ project }: { project: string }) {
  const epics = useAppState((s) => epicsTree(s, project));
  return (
    <ViewIn gap={14}>
      <View style={styles.treeHead}>
        <Txt v="section">Epics & sprints</Txt>
        <Txt v="meta" color={colors.ink3}>
          Epic → Sprint → Ticket
        </Txt>
      </View>
      {!epics.length ? <EmptyState icon="git-fork" text="No epics yet." /> : null}
      {epics.map((e) => (
        <EpicCard key={e.key} e={e} />
      ))}
    </ViewIn>
  );
}

function EpicCard({ e }: { e: TreeEpic }) {
  const { setUi } = useActions();
  const openMap = useAppState((s) => s.ui.epicOpen);
  return (
    <View style={styles.epic} testID={`epic-${e.name}`}>
      <Press
        label={`Epic ${e.name}, ${e.meta}`}
        a11yRole="button"
        aria-expanded={e.open}
        onPress={() => setUi({ epicOpen: { ...openMap, [e.key]: !e.open } })}
        scale={1}
        style={[styles.epicHead, { backgroundColor: e.tone.soft }]}
        testID={`epic-toggle-${e.name}`}
      >
        <View style={styles.epicChev}>
          <View style={{ transform: [{ rotate: e.open ? '90deg' : '0deg' }] }}>
            <Icon name="chevron-right" size={14} color={e.tone.ink} strokeWidth={2.8} />
          </View>
        </View>
        <View style={styles.flex}>
          <View style={styles.row7}>
            <View style={[styles.epicTag, { backgroundColor: e.tone.dot }]}>
              <Txt v="badge" color={colors.white} style={styles.epicTagText}>
                EPIC
              </Txt>
            </View>
            <Txt v="titleSm" w={800} numberOfLines={1} style={styles.flexShrink}>
              {e.name}
            </Txt>
          </View>
          <Txt v="caption" w={600} color={e.tone.ink} style={styles.mt3}>
            {e.meta}
          </Txt>
        </View>
        <Txt v="body" w={800} color={e.tone.ink}>{`${e.pct}%`}</Txt>
      </Press>
      {e.open ? (
        <View style={styles.epicBody}>
          <View style={[styles.spine, { borderLeftColor: e.tone.soft }]}>
            {e.sprints.map((x) => (
              <SprintBox key={x.key} x={x} line={e.tone.soft} />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function SprintBox({ x, line }: { x: TreeSprint; line: string }) {
  const { setUi } = useActions();
  const openMap = useAppState((s) => s.ui.sprintOpen);
  const st = SPRINT_STATE[x.sprint.st];
  const active = x.sprint.st === 'active';
  return (
    <View style={styles.sprintWrap} testID={`sprint-${x.key}`}>
      <View style={[styles.branch, { backgroundColor: line }]} />
      <View style={[styles.sprint, { borderColor: active ? colors.primary : colors.line, backgroundColor: active ? colors.sprintActiveBg : colors.bg }]}>
        <Press
          label={`${x.sprint.n}, ${st.label}, ${x.count}`}
          aria-expanded={x.open}
          onPress={() => setUi({ sprintOpen: { ...openMap, [x.key]: !x.open } })}
          scale={1}
          style={styles.sprintHead}
          testID={`sprint-toggle-${x.key}`}
        >
          <View style={styles.flex}>
            <View style={styles.row7}>
              <Txt v="bodyLg" w={800} style={styles.lh18}>
                {x.sprint.n}
              </Txt>
              <View style={[styles.spPill, { backgroundColor: st.soft }]}>
                <Dot color={st.dot} size={5} />
                <Txt v="chip" color={st.ink} style={styles.fs11}>
                  {st.label}
                </Txt>
              </View>
            </View>
            <Txt v="small" w={400} color={colors.ink3} style={styles.mt2}>
              {`${x.dates} · ${x.count}`}
            </Txt>
          </View>
          <View style={{ transform: [{ rotate: x.open ? '180deg' : '0deg' }] }}>
            <Icon name="chevron-down" size={14} color={colors.ink3} strokeWidth={2.6} />
          </View>
        </Press>
        {x.open ? (
          <View style={styles.sprintBody}>
            <View style={styles.dashed}>
              {x.tickets.map((t) => (
                <TreeTicketRow key={t.ticket.id} t={t} />
              ))}
              {!x.tickets.length ? (
                <Txt v="caption" color={colors.ink3} style={styles.noTickets}>
                  No tickets yet.
                </Txt>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function TreeTicketRow({ t }: { t: TreeSprint['tickets'][number] }) {
  const blink = useLoop(t.critical ? motion.critDot() : null);
  return (
    <Press label={`${t.ticket.key} ${t.ticket.title}, due ${t.due.label}`} onPress={() => toTicket(t.ticket.id)} style={styles.treeTicket} testID={`tree-ticket-${t.ticket.key}`}>
      <View style={styles.twig} />
      <Dot color={TICKET_STATUS[t.ticket.st].dot} size={8} />
      <Txt v="bodySm" w={600} numberOfLines={1} style={styles.flex}>
        {t.ticket.title}
      </Txt>
      {t.critical ? <Animated.View style={[styles.critSq, blink]} accessibilityLabel="Critical" /> : null}
      <Txt v="chip" w={t.due.weight} color={t.due.color}>
        {t.due.label}
      </Txt>
    </Press>
  );
}

// ── Timeline ────────────────────────────────────────────────────────────────

const BAR = { done: colors.green, active: colors.primary, planned: colors.faint } as const;

export function TimelineView({ project }: { project: string }) {
  const tl = useAppState((s) => timeline(s, project));
  return (
    <ViewIn>
      <View style={styles.tlCard} testID="project-timeline">
        <View style={styles.tlHead}>
          <Txt v="caption" w={700} color={colors.ink3}>
            Sprints
          </Txt>
          <Txt v="caption" w={700} color={colors.ink3}>
            {tl.range}
          </Txt>
        </View>
        {tl.rows.map((r) => (
          <View key={r.label} style={styles.tlRow}>
            <View style={styles.tlLabel}>
              <Txt v="meta" w={700} numberOfLines={1} style={styles.flexShrink}>
                {r.label}
              </Txt>
              <Txt v="meta" w={400} color={colors.ink3}>
                {r.dates}
              </Txt>
            </View>
            <View style={styles.track}>
              <View style={[styles.tlBar, { left: `${r.left}%`, width: `${r.width}%`, backgroundColor: BAR[r.state] }]} />
              <View style={[styles.today, { left: `${tl.today}%` }]} />
            </View>
          </View>
        ))}
        {!tl.empty ? (
          <View style={styles.legend}>
            {(['done', 'active', 'planned'] as const).map((k) => (
              <View key={k} style={styles.legendItem}>
                <View style={[styles.legendSq, { backgroundColor: BAR[k] }]} />
                <Txt v="small" color={colors.ink3}>
                  {SPRINT_STATE[k].label}
                </Txt>
              </View>
            ))}
            <View style={styles.legendItem}>
              <View style={styles.legendToday} />
              <Txt v="small" color={colors.ink3}>
                Today
              </Txt>
            </View>
          </View>
        ) : (
          <Txt v="bodySm" w={400} color={colors.ink3}>
            No sprints planned yet.
          </Txt>
        )}
      </View>
    </ViewIn>
  );
}

// ── Files (M-27) ────────────────────────────────────────────────────────────

export function FilesView({ project }: { project: string }) {
  const files = useAppState((s) => projectFiles(s, project));
  return (
    <ViewIn>
      <View style={styles.filesCard} testID="project-files">
        {files.map((f, i) => (
          <Press key={`${f.ticketId}-${f.name}`} label={`${f.name}, ${f.sub}`} onPress={() => toTicket(f.ticketId)} scale={1} style={[styles.fileRow, i > 0 && styles.divider]} testID={`file-${f.name}`}>
            <IconTile icon={f.icon} size={38} radius={10} iconSize={18} />
            <View style={styles.flex}>
              <Txt v="bodyLg" w={700} style={styles.lh19}>
                {f.name}
              </Txt>
              <Txt v="small" w={400} color={colors.ink3} numberOfLines={1}>
                {f.sub}
              </Txt>
            </View>
          </Press>
        ))}
        {!files.length ? (
          <Txt v="bodySm" w={400} color={colors.ink3} align="center" style={styles.noFiles}>
            No files attached to tickets yet.
          </Txt>
        ) : null}
      </View>
    </ViewIn>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  mt2: { marginTop: 2 },
  mt3: { marginTop: 3 },
  lh18: { lineHeight: 18 },
  lh19: { lineHeight: 19 },
  fs11: { fontSize: 11 },
  row7: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  cards: { gap: 8, marginTop: 8 },
  bleed: { marginHorizontal: -16 },
  boardRow: { paddingHorizontal: 16, paddingBottom: 6, gap: 10, alignItems: 'flex-start' },
  col: { width: 280, padding: 10, borderRadius: radii.card, backgroundColor: colors.track },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 2, paddingHorizontal: 4 },
  treeHead: { flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 4 },
  epic: { borderRadius: radii.hero, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  epicHead: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  epicChev: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  epicTag: { paddingHorizontal: 6, height: 19, borderRadius: 5, justifyContent: 'center' },
  epicTagText: { letterSpacing: 0.6 },
  epicBody: { paddingTop: 6, paddingRight: 12, paddingBottom: 14, paddingLeft: 26 },
  spine: { paddingLeft: 16, borderLeftWidth: 2 },
  sprintWrap: { marginTop: 10 },
  branch: { position: 'absolute', left: -17, top: 22, width: 14, height: 2 },
  sprint: { borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  sprintHead: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 11, paddingHorizontal: 12 },
  spPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 5, paddingRight: 7, height: 19, borderRadius: radii.pill },
  sprintBody: { paddingRight: 10, paddingBottom: 10, paddingLeft: 22 },
  dashed: { paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.lineInput, borderStyle: 'dashed', gap: 6 },
  treeTicket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.lineHeader,
  },
  twig: { position: 'absolute', left: -15, top: '50%', width: 12, height: 2, backgroundColor: colors.lineInput },
  critSq: { width: 8, height: 8, borderRadius: 2, backgroundColor: colors.danger },
  noTickets: { paddingVertical: 4 },
  tlCard: { padding: 14, borderRadius: radii.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 12 },
  tlHead: { flexDirection: 'row', justifyContent: 'space-between' },
  tlRow: { gap: 5 },
  tlLabel: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  track: { height: 14, borderRadius: 7, backgroundColor: colors.divider },
  tlBar: { position: 'absolute', top: 0, bottom: 0, borderRadius: 7 },
  today: { position: 'absolute', top: -3, bottom: -3, width: 2, backgroundColor: colors.danger },
  legend: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSq: { width: 8, height: 8, borderRadius: 2 },
  legendToday: { width: 2, height: 10, backgroundColor: colors.danger },
  filesCard: { borderRadius: radii.card, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  noFiles: { padding: 30 },
});
