import { useState } from 'react';

import { Block, IconTile, Row, Rows, Screen, Segmented, TextBlock, TextTile, showToast } from '@/components';
import { me, devopsAll, canEditDevopsSettings } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { DevopsRule } from '@/data/types';
import { colors, tones } from '@/theme';

import { devopsTone, phaseOf, phaseTone } from './board';
import { DvSetItemSheet } from './DevopsSheets';

type Seg = 'st' | 'seq' | 'ph' | 'rules';

const RULES: { key: DevopsRule; title: string; sub?: string }[] = [
  { key: 'requireNote', title: 'Require a note on every follow-up', sub: 'Also saved as the reason if the estimated deployment moves' },
  { key: 'requireReminder', title: 'Require the next reminder date' },
  { key: 'lockInitial', title: 'Lock initial due date once saved' },
  { key: 'lockDevDue', title: 'Lock dev phase due date once saved' },
];

/** S5-DVSET DevOps settings: Statuses · Follow-ups · Dev phases · Rules (V-100). Edit = super, admin, devops. */
export function DevopsSettingsScreen() {
  const S = useAppState((s) => s.devopsSettings);
  const ce = useAppState((s) => canEditDevopsSettings(me(s)?.role));
  const all = useAppState(devopsAll);
  const { toggleDevopsRule } = useActions();
  const [v, setV] = useState<Seg>('st');
  const [item, setItem] = useState<{ list: 'statuses' | 'phases'; index: number | null } | null>(null);

  return (
    <Screen title="Settings" sub="DevOps board" testID="screen-dvset">
      <Segmented
        options={[
          { value: 'st', label: 'Statuses' },
          { value: 'seq', label: 'Follow-ups' },
          { value: 'ph', label: 'Dev phases' },
          { value: 'rules', label: 'Rules' },
        ]}
        value={v}
        onChange={setV}
        testID="dvset-seg"
      />
      {v === 'st' ? (
        <>
          <Block
            title="Statuses"
            sub="Renaming updates every project."
            action={ce ? '+ Add status' : undefined}
            onAction={() => setItem({ list: 'statuses', index: null })}
            actionTestID="dvset-add-status"
          >
            <Rows testID="dvset-statuses">
              {S.statuses.map((s, i) => {
                const t = tones[devopsTone(s)];
                return (
                  <Row
                    key={s}
                    lead={<IconTile icon="circle-dot" bg={t.soft} fg={t.ink} />}
                    title={s}
                    sub={`${all.filter((d) => d.infra === s).length} projects`}
                    badge={{ label: phaseOf(s), tone: phaseTone(s) }}
                    onPress={ce ? () => setItem({ list: 'statuses', index: i }) : undefined}
                    testID={`dvset-status-${i}`}
                  />
                );
              })}
            </Rows>
          </Block>
          <TextBlock tone="info" text="Projects on a removed status move to the first status." />
        </>
      ) : null}
      {v === 'seq' ? (
        <>
          <Block title="Client" sub="Fixed schedule">
            <Rows testID="dvset-ladder">
              {S.ladder.map((x, i) => {
                const esc = i >= S.esc;
                return (
                  <Row
                    key={x.n}
                    lead={<TextTile text={String(i + 1)} bg={esc ? colors.redSoft : colors.primarySoft} fg={esc ? colors.redInk : colors.primaryInk} />}
                    title={x.n}
                    sub={i ? `+${x.h} hours after previous` : 'Starts when status moves to Client onboarding'}
                    subWrap
                    badge={i === S.esc ? { label: 'Escalate from', tone: 'red' } : undefined}
                  />
                );
              })}
            </Rows>
          </Block>
          <Block title="Internal · dev team" sub="Used when action is from the development team or DevOps">
            <Rows testID="dvset-iladder">
              {S.iladder.map((n, i) => (
                <Row key={n} lead={<TextTile text={String(i + 1)} bg={colors.track} fg={colors.ink2} />} title={n} sub="You set each date when moving to the step" subWrap />
              ))}
            </Rows>
          </Block>
        </>
      ) : null}
      {v === 'ph' ? (
        <Block
          title="Dev phases"
          sub="Typical duration pre-fills the due date"
          action={ce ? '+ Add phase' : undefined}
          onAction={() => setItem({ list: 'phases', index: null })}
          actionTestID="dvset-add-phase"
        >
          <Rows testID="dvset-phases">
            {S.phases.map((p, i) => (
              <Row
                key={`${p.n}-${i}`}
                lead={<IconTile icon="milestone" />}
                title={p.n}
                right={p.d ? `${p.d} days` : '—'}
                rightColor={colors.ink}
                onPress={ce ? () => setItem({ list: 'phases', index: i }) : undefined}
                testID={`dvset-phase-${i}`}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {v === 'rules' ? (
        <Block title="Date rules" sub="What's required and what's locked when dates change.">
          <Rows testID="dvset-rules">
            {RULES.map((r) => (
              <Row
                key={r.key}
                title={r.title}
                sub={r.sub}
                subWrap
                toggle={!!S.rules[r.key]}
                onPress={
                  ce
                    ? () => {
                        const x = toggleDevopsRule(r.key);
                        if (!x.ok) showToast(x.error);
                      }
                    : undefined
                }
                testID={`dvset-rule-${r.key}`}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {item ? <DvSetItemSheet visible list={item.list} index={item.index} onClose={() => setItem(null)} /> : null}
    </Screen>
  );
}
