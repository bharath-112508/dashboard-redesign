import { ScrollView, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Avatar } from '@/components/Avatar';
import { Card, Section } from '@/components/Card';
import { CriticalBadge } from '@/components/Chips';
import { CompanyLogo } from '@/components/CompanyLogo';
import { KpiTile, ProgressBar } from '@/components/DataDisplay';
import { IconTile } from '@/components/IconTile';
import { Press } from '@/components/Press';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { greetingFor, TODAY } from '@/data/clock';
import { dow, sh } from '@/data/format';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { goTab, href, push } from '@/nav/routes';
import { homeVariant } from '@/nav/tabs';
import { colors, motion, radii, space } from '@/theme';

import {
  homeKpis,
  homeLists,
  homeProjects,
  homeTeam,
  homeWeek,
  type HomeList,
  type HomeRow,
  type HomeTarget,
} from './selectors';

/** Navigate to a Home target (M-44). */
export function goHomeTarget(t: HomeTarget): void {
  switch (t.kind) {
    case 'tab':
      goTab(t.tab);
      return;
    case 'ticket':
      push(href.ticket(t.id));
      return;
    case 'question':
      push(href.question(t.id));
      return;
    case 'project':
      push(href.project(t.name));
      return;
    case 'leave':
      push(href.leave());
      return;
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** S-HOME: one screen, four variants (homeVariant(role)). */
export function HomeScreen() {
  const person = useAppState(me);
  const kpis = useAppState(homeKpis);
  const lists = useAppState(homeLists);
  const week = useAppState(homeWeek);
  const projects = useAppState(homeProjects);
  const team = useAppState(homeTeam);
  if (!person?.role) return <Screen title="Home" header="large" testID="screen-home">{null}</Screen>;
  const variant = homeVariant(person.role);
  const first = person.name.split(/\s+/)[0];

  return (
    <Screen title="Home" header="large" gap={space.gap.section} testID="screen-home">
      <Txt v="rowTitle" w={600} color={colors.ink2} testID="home-greeting">
        {`${greetingFor()}, ${first} · ${dow(TODAY)} ${sh(TODAY)}`}
      </Txt>

      <View style={styles.kpis} testID={`home-${variant}`}>
        {kpis.map((k, i) => (
          <KpiTile
            key={k.label}
            index={i}
            label={k.label}
            value={k.value}
            sub={k.sub}
            icon={k.icon}
            accent={k.accent}
            accentSoft={k.accentSoft}
            valueColor={k.valueColor}
            iconAnim={k.anim}
            onPress={() => goHomeTarget(k.target)}
            testID={`home-kpi-${slug(k.label)}`}
          />
        ))}
      </View>

      {lists.map((l, li) => (
        <HomeListSection key={l.id} list={l} index={li} />
      ))}

      {variant !== 'client' ? (
        <Card onPress={() => goTab('time')} label={`This week, ${week.total}. Open Timesheet`} pad={space.card.hero} testID="home-week">
          <View style={styles.headRow}>
            <Txt v="section">This week</Txt>
            <Txt v="meta" color={colors.ink3}>
              {week.range}
            </Txt>
          </View>
          <View style={styles.weekBars}>
            {week.days.map((d) => (
              <View key={d.d} style={styles.weekCol}>
                <Txt v="chip" color={colors.ink2}>
                  {d.hours}
                </Txt>
                <View style={styles.weekBar}>
                  <View style={{ height: `${Math.min(100, d.bill * 10)}%`, backgroundColor: colors.primary }} />
                  <View style={{ height: `${Math.min(100, d.non * 10)}%`, backgroundColor: colors.nonBillable }} />
                  <View style={{ height: `${Math.min(100, d.idle * 10)}%`, backgroundColor: colors.idle }} />
                </View>
                <Txt v="chip" w={d.isToday ? 800 : 600} color={d.isToday ? colors.primaryInk : colors.ink3}>
                  {d.label}
                </Txt>
              </View>
            ))}
          </View>
          <View style={styles.legend}>
            <Legend color={colors.primary} label="Billable" />
            <Legend color={colors.nonBillable} label="Non-billable" />
            {week.showIdle ? <Legend color={colors.idle} label="Idle" /> : null}
            <Txt v="meta" w={800} style={styles.legendTotal} testID="home-week-total">
              {week.total}
            </Txt>
          </View>
        </Card>
      ) : null}

      {projects.length ? (
        <Section title="Active projects" link="See all" onLink={() => goTab('projects')}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.carousel} contentContainerStyle={styles.carouselInner}>
            {projects.map((p) => (
              <Card
                key={p.name}
                onPress={() => push(href.project(p.name))}
                label={`${p.name}, ${p.company}, ${p.caption}, ${p.pct}%`}
                style={styles.projCard}
                testID={`home-project-${slug(p.name)}`}
              >
                <View style={styles.projHead}>
                  <CompanyLogo company={p.company} size={32} radius={9} />
                  <View style={styles.flex}>
                    <Txt v="bodyLg" w={700} numberOfLines={1} style={styles.tight}>
                      {p.name}
                    </Txt>
                    <Txt v="small" w={400} color={colors.ink3} numberOfLines={1}>
                      {p.company}
                    </Txt>
                  </View>
                </View>
                <View style={styles.projFoot}>
                  <Txt v="small" color={colors.ink2}>
                    {p.caption}
                  </Txt>
                  <Txt v="small" w={800}>{`${p.pct}%`}</Txt>
                </View>
                <ProgressBar pct={p.pct} height={6} track={colors.primarySoft} label={`${p.name} progress`} />
              </Card>
            ))}
          </ScrollView>
        </Section>
      ) : null}

      {variant === 'staffAll' ? (
        <Card pad={space.card.hero} testID="home-team">
          <View style={styles.headRow}>
            <Txt v="section">Team hours</Txt>
            <Txt v="meta" color={colors.ink3}>
              This week
            </Txt>
          </View>
          <View style={styles.team}>
            {team.map((m) => (
              <View key={m.name} style={styles.teamRow} testID={`home-team-${slug(m.name)}`}>
                <Avatar name={m.name} size={32} radius={9} />
                <View style={styles.flex}>
                  <View style={styles.teamName}>
                    <Txt v="body" w={700}>
                      {m.name}
                    </Txt>
                    {m.sub ? (
                      <Txt v="small" w={400} color={colors.ink3}>
                        {m.sub}
                      </Txt>
                    ) : null}
                    <Txt v="meta" w={800} style={styles.legendTotal}>
                      {m.hours}
                    </Txt>
                  </View>
                  <View style={styles.teamBar}>
                    <View style={{ width: `${Math.min(100, (m.bill / 40) * 100)}%`, backgroundColor: colors.primary }} />
                    <View style={{ width: `${Math.min(100, (m.non / 40) * 100)}%`, backgroundColor: colors.nonBillable }} />
                    <View style={{ width: `${Math.min(100, (m.idle / 40) * 100)}%`, backgroundColor: colors.idle }} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : null}
    </Screen>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <Txt v="small" color={colors.ink3}>
        {label}
      </Txt>
    </View>
  );
}

function HomeListSection({ list, index }: { list: HomeList; index: number }) {
  return (
    <View style={styles.listSection} testID={`home-list-${list.id}`}>
      <Section title={list.title} count={list.rows.length} link={list.link} onLink={() => goHomeTarget(list.linkTarget)}>
        <View style={styles.listCard}>
          {list.rows.map((r, i) => (
            <HomeListRow key={r.key} row={r} first={i === 0} delay={0.25 + index * 0.1 + i * 0.05} />
          ))}
          {!list.rows.length ? (
            <View style={styles.empty}>
              <Txt v="body" color={colors.ink3}>
                {list.empty}
              </Txt>
            </View>
          ) : null}
        </View>
      </Section>
    </View>
  );
}

function HomeListRow({ row, first, delay }: { row: HomeRow; first: boolean; delay: number }) {
  return (
    <Animated.View style={motion.fadeUp(0, delay, 0)}>
      <Press
        label={`${row.tag}${row.critical ? ', Critical' : ''}, ${row.title}, ${row.meta}${row.right ? `, ${row.right}` : ''}`}
        onPress={() => goHomeTarget(row.target)}
        scale={1}
        style={[styles.row, !first && styles.rowDivider]}
        testID={`home-row-${slug(row.key)}`}
      >
        <IconTile icon={row.icon} bg={row.iconBg} fg={row.iconFg} size={40} radius={radii.input} iconSize={18} />
        <View style={styles.flex}>
          <View style={styles.tagRow}>
            <View style={[styles.tag, { backgroundColor: row.tagBg }]}>
              <Txt v="chip" color={row.tagFg} numberOfLines={1}>
                {row.tag}
              </Txt>
            </View>
            {row.critical ? <CriticalBadge /> : null}
          </View>
          <Txt v="rowTitle" numberOfLines={1} style={styles.rowTitle}>
            {row.title}
          </Txt>
          <Txt v="caption" color={colors.ink3} numberOfLines={1}>
            {row.meta}
          </Txt>
        </View>
        {row.right ? (
          <Txt v="caption" w={800} color={row.rightColor}>
            {row.right}
          </Txt>
        ) : null}
      </Press>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  tight: { lineHeight: 19 },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: space.gap.kpi },
  listSection: { gap: 0 },
  listCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: space.card.rowV,
    paddingHorizontal: space.card.rowH,
    backgroundColor: colors.surface,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.divider },
  rowTitle: { marginTop: 5 },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  tag: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radii.key, maxWidth: '100%' },
  empty: { paddingVertical: 18, paddingHorizontal: 14 },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  weekBars: { marginTop: 14, flexDirection: 'row', gap: 10, alignItems: 'flex-end', height: 110 },
  weekCol: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 5, height: '100%' },
  weekBar: {
    width: '100%',
    maxWidth: 34,
    height: 72,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: colors.track,
    flexDirection: 'column-reverse',
  },
  legend: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch: { width: 8, height: 8, borderRadius: 2 },
  legendTotal: { marginLeft: 'auto' },
  carousel: { marginHorizontal: -space.gutter },
  carouselInner: { paddingHorizontal: space.gutter, paddingTop: 2, paddingBottom: 4, gap: 10 },
  projCard: { width: 210 },
  projHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  projFoot: { marginTop: 12, marginBottom: 5, flexDirection: 'row', justifyContent: 'space-between' },
  team: { marginTop: 12, gap: 12 },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  teamName: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  teamBar: { marginTop: 5, height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: colors.track, flexDirection: 'row' },
});
