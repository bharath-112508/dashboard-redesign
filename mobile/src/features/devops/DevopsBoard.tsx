import { StyleSheet, View } from 'react-native';

import { CompanyLogo, Dot, Icon, Press, Screen, Toggle, Txt } from '@/components';
import { showToast } from '@/components/Toast';
import { PHASE_TONE, PHASE_TONE_FALLBACK } from '@/data/constants';
import { sh } from '@/data/format';
import { me, nextPhase } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { DevopsProject } from '@/data/types';
import { SCREEN_TITLES, tabTitle } from '@/nav/titles';
import { colors, pressScale, radii, space } from '@/theme';

/**
 * S-DEVOPS: one card per DevOps project; tapping a card expands it (M-37).
 * `variant` "tab" is the devops role's tab root; "stack" is the pushed copy for pm/admin/super.
 */
export function DevopsBoardScreen({ variant }: { variant: 'tab' | 'stack' }) {
  const role = useAppState((s) => me(s)?.role ?? 'devops');
  const projects = useAppState((s) => s.devops);
  return (
    <Screen
      title={variant === 'tab' ? tabTitle('devops', role) : SCREEN_TITLES.devops}
      header={variant === 'tab' ? 'large' : 'small'}
      gap={10}
      contentStyle={variant === 'stack' ? styles.stackContent : undefined}
      testID={variant === 'tab' ? 'screen-devops' : 'screen-stack-devops'}
    >
      {projects.map((d) => (
        <DevopsCard key={d.p} d={d} />
      ))}
    </Screen>
  );
}

/** "Reminder 2 · in 3d" / "· today" (amber) / "· 1d late" (red). */
function reminderLabel(d: DevopsProject): { text: string; color: string } {
  if (d.remIn < 0) return { text: `${d.rem} · ${-d.remIn}d late`, color: colors.danger };
  if (d.remIn === 0) return { text: `${d.rem} · today`, color: colors.amberInk };
  return { text: `${d.rem} · in ${d.remIn}d`, color: colors.ink };
}

function DevopsCard({ d }: { d: DevopsProject }) {
  const open = useAppState((s) => !!s.ui.devopsOpen[d.p]);
  const devopsOpen = useAppState((s) => s.ui.devopsOpen);
  const next = useAppState((s) => nextPhase(s, d));
  const { setUi, advanceDevopsPhase } = useActions();
  const tone = PHASE_TONE[d.phase] ?? PHASE_TONE_FALLBACK;
  const rem = reminderLabel(d);
  const late = d.remIn < 0;
  const toggle = () => setUi({ devopsOpen: { ...devopsOpen, [d.p]: !open } });
  const move = () => {
    const msg = advanceDevopsPhase(d.p);
    if (msg) showToast(msg);
  };
  return (
    <View style={[styles.card, { borderColor: late ? colors.dangerRing : colors.line }]} testID={`devops-card-${d.p}`}>
      <Press
        label={`${d.p}, ${d.phase}`}
        a11yRole="button"
        aria-expanded={open}
        onPress={toggle}
        scale={pressScale.card}
        style={styles.head}
        testID={`devops-toggle-${d.p}`}
      >
        <View style={styles.row}>
          <CompanyLogo company={d.co} size={32} radius={9} />
          <View style={styles.flex}>
            <Txt v="cardTitle" w={800} numberOfLines={1}>
              {d.p}
            </Txt>
            <Txt v="small" w={400} color={colors.ink3}>
              {d.co}
            </Txt>
          </View>
          <View style={styles.ci}>
            <Txt v="small" w={700} color={colors.ink2}>
              CI/CD
            </Txt>
            <Toggle value={d.ci} label={`CI/CD ${d.ci ? 'on' : 'off'}`} onColor={colors.green} readOnly size="sm" />
          </View>
        </View>
        <View style={[styles.phase, { backgroundColor: tone.soft }]} testID="devops-phase">
          <Dot color={tone.dot} size={7} />
          <Txt v="caption" w={700} color={tone.ink}>
            {d.phase}
          </Txt>
        </View>
        <View style={styles.tiles}>
          <View style={styles.tile}>
            <Txt v="eyebrow" color={colors.ink3} style={styles.tileLabel}>
              Next reminder
            </Txt>
            <Txt v="body" w={800} color={rem.color} testID="devops-reminder">
              {rem.text}
            </Txt>
          </View>
          <View style={styles.tile}>
            <Txt v="eyebrow" color={colors.ink3} style={styles.tileLabel}>
              Est. deployment
            </Txt>
            <Txt v="body" w={800}>
              {sh(d.est)}
            </Txt>
          </View>
        </View>
      </Press>
      {open ? (
        <View style={styles.body} testID={`devops-expanded-${d.p}`}>
          {next ? (
            <Press label={`Move to ${next}`} onPress={move} scale={pressScale.tile} style={styles.move} testID="devops-move">
              <Icon name="arrow-right-circle" size={17} color={colors.white} />
              <Txt v="body" w={700} color={colors.white}>
                {`Move to ${next}`}
              </Txt>
            </Press>
          ) : null}
          {d.deps.length ? (
            <>
              <Txt v="eyebrow" color={colors.ink3} style={styles.eyebrow}>
                Deployments
              </Txt>
              <View style={styles.timeline}>
                <View style={styles.track} />
                {d.deps.map((x) => {
                  const rb = x.st !== 'Live';
                  return (
                    <View key={x.v} style={styles.dep}>
                      <View style={[styles.depDot, { backgroundColor: rb ? colors.danger : colors.green }]} />
                      <Txt v="bodySm" w={800}>
                        {x.v}
                      </Txt>
                      <Txt v="bodySm" w={400} color={colors.ink2} numberOfLines={1} style={styles.flex}>
                        {x.note}
                        {rb ? <Txt v="bodySm" w={400} color={colors.dangerInk}>{' · rolled back'}</Txt> : null}
                      </Txt>
                      <Txt v="caption" color={colors.ink3}>
                        {x.day}
                      </Txt>
                    </View>
                  );
                })}
              </View>
            </>
          ) : null}
          <Txt v="eyebrow" color={colors.ink3} style={styles.eyebrow}>
            What happened
          </Txt>
          <View testID="devops-log">
            {d.log.map((l, i) => (
              <View key={i} style={styles.logRow}>
                <Txt v="small" w={700} color={colors.ink3} style={styles.logDay}>
                  {l[0]}
                </Txt>
                <Txt v="bodySm" w={400} style={styles.flex}>
                  <Txt v="bodySm" w={700}>
                    {l[1]}
                  </Txt>
                  {` · ${l[2]}`}
                </Txt>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stackContent: { paddingTop: 8 },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, borderWidth: 1, overflow: 'hidden' },
  head: { padding: space.card.pad, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  flex: { flex: 1, minWidth: 0 },
  ci: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  phase: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingVertical: 4,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: radii.pill,
  },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, paddingVertical: 9, paddingHorizontal: 10, borderRadius: 10, backgroundColor: colors.bg, gap: 3 },
  tileLabel: { fontSize: 11 },
  body: { paddingHorizontal: space.card.pad, paddingBottom: 12 },
  move: {
    height: 44,
    marginBottom: 12,
    borderRadius: 22,
    backgroundColor: colors.ink,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  eyebrow: { paddingTop: 4 },
  timeline: { marginTop: 8, marginBottom: 14, paddingLeft: 18 },
  track: { position: 'absolute', left: 4, top: 9, bottom: 9, width: 2, backgroundColor: colors.line },
  dep: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  depDot: { position: 'absolute', left: -18, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.white },
  logRow: { flexDirection: 'row', gap: 10, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.divider, marginTop: 6 },
  logDay: { width: 44 },
});
