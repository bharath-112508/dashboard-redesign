import { useState } from 'react';

import { Avatar, IconTile, ProjectTile } from '@/components/Avatar';
import { ConfirmSheet } from '@/components/BottomSheet';
import { Button, ButtonRow } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { EmptyBlock } from '@/components/EmptyBlock';
import { Hero } from '@/components/Hero';
import { KpiGrid } from '@/components/KpiGrid';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { TextBlock } from '@/components/TextBlock';
import { showToast, toastResult } from '@/components/Toast';
import { WeekBars } from '@/components/WeekBars';
import { WEEK_MONDAY } from '@/data/clock';
import { ANNUAL_LEAVE_DAYS, ROLE_LABEL } from '@/data/constants';
import { addD, fmtL, hm } from '@/data/format';
import { demoCheckIn } from '@/data/seed/dashboardDemo';
import { entriesBetween, isFreelancer, myCan, myPerm, projAll, weekBars } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { back, href, openSheet, push } from '@/nav/routes';
import { colors } from '@/theme';

import { annualLeft } from '../leave/leave';
import { LeaveRows } from '../leave/LeaveRows';
import { sum } from '../time/timeMath';

/**
 * S5-USER: hero, Working on, and for staff the week bars, demo check-ins, leave balance
 * and requests. With `users.manage`: Edit user, Deactivate / Activate, Remove user (V-72).
 */
export function UserScreen({ id }: { id: number }) {
  const u = useAppState((s) => s.people.find((p) => p.id === id) ?? null);
  const all = useAppState(projAll);
  const canProjects = useAppState((s) => myCan(s, 'Projects'));
  const canManage = useAppState((s) => myPerm(s, 'users.manage'));
  const leaves = useAppState((s) => s.leaves);
  const week = useAppState((s) => (u ? entriesBetween(s, WEEK_MONDAY, addD(WEEK_MONDAY, 6), u.name) : []));
  const free = isFreelancer(u);
  const bars = useAppState((s) => (u ? weekBars(s, WEEK_MONDAY, u.name, { idle: !free }) : []));
  const { setUserActive, removeUser } = useActions();
  const [confirm, setConfirm] = useState(false);
  if (!u) {
    return (
      <Screen title="User" testID="screen-user">
        <EmptyBlock text="User not found." />
      </Screen>
    );
  }
  const client = u.org !== 'vt';
  const PR = u.projects === 'all' ? all : all.filter((p) => (u.projects as string[]).includes(p.id));
  const mineLeave = leaves.filter((l) => l.who === u.name);
  const total = sum(week);
  return (
    <Screen title={u.name} sub={ROLE_LABEL[u.role]} testID="screen-user">
      <Hero
        lead={<Avatar name={u.name} size={46} radius={14} />}
        eyebrow={ROLE_LABEL[u.role]}
        title={u.name}
        sub={u.email}
        status={u.active ? { label: 'Active', tone: 'green' } : { label: 'Deactivated', tone: 'red' }}
        chips={[
          u.devType ? { text: u.devType, dot: colors.primary, bg: colors.bg } : null,
          { text: u.emp === 'freelancer' ? 'Freelancer' : client ? 'Client' : 'Employee', dot: colors.violet, bg: colors.bg },
          { text: `Last active ${u.last}`, dot: colors.faint, bg: colors.bg },
        ].filter((c): c is NonNullable<typeof c> => !!c)}
        testID="user-hero"
      />
      <Block title="Working on" sub={u.projects === 'all' ? 'All projects' : ''}>
        <Rows empty="Not assigned to any project yet." testID="user-projects">
          {PR.map((p) => (
            <Row key={p.id} lead={<ProjectTile id={p.id} />} title={p.name} sub={p.co} onPress={canProjects ? () => push(href.project(p.id)) : undefined} />
          ))}
        </Rows>
      </Block>
      {client ? (
        <TextBlock tone="info" text="Client users don't log time, attendance or leave. Only their project access is shown." />
      ) : (
        <>
          <Block title="Week" sub={`${hm(total)} logged · 8h required a day`}>
            <WeekBars days={bars} idle={!free} foot={hm(total)} testID="user-week" />
          </Block>
          <Block title="Check-ins this week">
            <Rows testID="user-checkins">
              {[0, 1, 2, 3, 4].map((i) => {
                const d = addD(WEEK_MONDAY, i);
                const m = sum(week.filter((e) => e.date === d));
                const c = demoCheckIn(u.name, i);
                const on = !!c;
                return (
                  <Row
                    key={d}
                    lead={<IconTile icon={on ? 'log-in' : 'minus'} bg={on ? colors.greenSoft : colors.track} fg={on ? colors.greenInk : colors.ink3} />}
                    title={fmtL(d)}
                    sub={m && c ? `In ${c.in} · Out ${c.out}` : 'No check-in'}
                    right={m ? hm(m) : undefined}
                    rightColor={colors.ink}
                  />
                );
              })}
            </Rows>
          </Block>
          <KpiGrid items={[{ label: 'Annual leave left', value: `${annualLeft(leaves, u.name)} days`, sub: `of ${ANNUAL_LEAVE_DAYS} this year`, dot: colors.primary, testID: 'user-annual-left' }]} />
          <Block title="Requests" action="+ Add leave" onAction={() => openSheet('leave', { who: u.name })} actionTestID="user-add-leave">
            <LeaveRows items={mineLeave} empty="No leave requests." testID="user-leave" />
          </Block>
        </>
      )}
      {canManage ? (
        <>
          <ButtonRow>
            <Button title="Edit user" icon="pencil" kind="s" onPress={() => openSheet('user', { id: u.id })} testID="user-edit" />
            <Button
              title={u.active ? 'Deactivate' : 'Activate'}
              icon={u.active ? 'user-x' : 'user-check'}
              kind="s"
              onPress={() => toastResult(setUserActive(u.id, !u.active))}
              testID="user-active"
            />
          </ButtonRow>
          {u.role !== 'super' ? <Button title="Remove user" icon="trash-2" kind="d" onPress={() => setConfirm(true)} testID="user-remove" /> : null}
        </>
      ) : null}
      <ConfirmSheet
        visible={confirm}
        title={`Remove ${u.name}?`}
        text="Their time history is kept. They can no longer sign in."
        confirm="Remove user"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          const r = removeUser(u.id);
          if (r.ok) back();
          showToast(r.ok ? r.toast : r.error);
        }}
        testID="confirm-remove"
      />
    </Screen>
  );
}
