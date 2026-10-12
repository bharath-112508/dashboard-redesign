import { useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { SearchField } from '@/components/SearchField';
import { FilterChips, Segmented } from '@/components/Segmented';
import { TextBlock } from '@/components/TextBlock';
import { showToast } from '@/components/Toast';
import { PERMS, ROLE_COLOURS, ROLE_LABEL, ROLES } from '@/data/constants';
import { canEditPermissions, myPerm, myRole } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { MatrixRole, Role } from '@/data/types';
import { href, openSheet, push } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { LeaveRows } from '../leave/LeaveRows';
import { splitLeave } from '../leave/leave';
import { filterUsers, userSub, type OrgFilter } from './admin';

type Seg = 'users' | 'leave' | 'perms';

/** S5-USERS (super, admin): Users · Leave · Permissions. The cadmin variant is W4's ClientTeamScreen. */
export function UsersScreen() {
  const actions = useRootActions();
  const pending = useAppState((s) => s.leaves.filter((l) => l.st === 'pending').length);
  const [v, setV] = useState<Seg>('users');
  return (
    <Screen title="Users" sub="Workspace settings" actions={actions} testID="screen-users">
      <Segmented
        options={[
          { value: 'users', label: 'Users' },
          { value: 'leave', label: 'Leave', count: pending || undefined },
          { value: 'perms', label: 'Permissions' },
        ]}
        value={v}
        onChange={setV}
        testID="users-seg"
      />
      {v === 'users' ? <UsersList /> : v === 'leave' ? <LeaveList /> : <PermsList />}
    </Screen>
  );
}

function UsersList() {
  const people = useAppState((s) => s.people);
  const canManage = useAppState((s) => myPerm(s, 'users.manage'));
  const [q, setQ] = useState('');
  const [org, setOrg] = useState<OrgFilter>('vt');
  const [rf, setRf] = useState<Role | 'all'>('all');
  const L = filterUsers(people, q, org, rf);
  return (
    <>
      <SearchField value={q} onChange={setQ} placeholder="Search people" testID="users-search" />
      <Segmented
        options={[
          { value: 'vt', label: 'Viljetech' },
          { value: 'client', label: 'Clients' },
          { value: 'all', label: 'All' },
        ]}
        value={org}
        onChange={setOrg}
        testID="users-org"
      />
      <FilterChips options={[{ value: 'all', label: 'All roles' }, ...ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))]} value={rf} onChange={(x) => setRf(x as Role | 'all')} testID="users-role" />
      <Block
        title={`${L.length} users`}
        action={canManage ? '+ Add user' : undefined}
        onAction={canManage ? () => openSheet('user') : undefined}
        actionTestID="users-add"
      >
        <Rows empty="No users match these filters." testID="users-list">
          {L.map((u) => (
            <Row
              key={u.id}
              lead={<Avatar name={u.name} />}
              title={u.name}
              sub={userSub(u)}
              badge={{ label: ROLE_LABEL[u.role], tone: { bg: ROLE_COLOURS[u.role].bg, ink: ROLE_COLOURS[u.role].ink, dot: ROLE_COLOURS[u.role].ink } }}
              right={u.active ? u.last : 'Deactivated'}
              rightColor={u.active ? colors.ink3 : colors.redInk}
              opacity={u.active ? 1 : 0.6}
              onPress={() => push(href.user(u.id))}
              testID={`user-row-${u.id}`}
            />
          ))}
        </Rows>
      </Block>
    </>
  );
}

function LeaveList() {
  const leaves = useAppState((s) => s.leaves);
  const { pending, decided } = splitLeave(leaves);
  return (
    <>
      <Button title="Add leave" icon="calendar-plus" onPress={() => openSheet('leave')} testID="users-leave-add" />
      <Block title="Requests" sub={`${pending.length} waiting for approval`}>
        <LeaveRows items={pending} empty="No pending requests." testID="leave-pending" />
      </Block>
      <Block title="Decided">
        <LeaveRows items={decided} empty="Nothing decided yet." testID="leave-decided" />
      </Block>
    </>
  );
}

/** The matrix toggles without a toast (v5); only a refusal is shown. */
const silentOk = (r: { ok: boolean; error?: string }) => {
  if (!r.ok) showToast(r.error);
};

const MATRIX_ROLES: MatrixRole[] = ['admin', 'pm', 'dev', 'devops'];

function PermsList() {
  const [sel, setSel] = useState<MatrixRole>('admin');
  const perms = useAppState((s) => s.perms);
  const canEdit = useAppState((s) => canEditPermissions(myRole(s)));
  const { togglePermission } = useActions();
  return (
    <>
      <FilterChips options={MATRIX_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} value={sel} onChange={(x) => setSel(x as MatrixRole)} testID="perm-role" />
      <Block title="Permission" sub={ROLE_LABEL[sel]}>
        <Rows testID="perm-list">
          {PERMS.map((p) => {
            const on = !!perms[sel]?.[p.key];
            return (
              <Row
                key={p.key}
                title={p.label}
                toggle={on}
                label={`${p.label} for ${ROLE_LABEL[sel]}`}
                onPress={canEdit ? () => silentOk(togglePermission(sel, p.key)) : undefined}
                testID={`perm-${p.key}`}
              />
            );
          })}
        </Rows>
      </Block>
      <TextBlock tone="info" text="Super admin always has every permission. Changes apply to everyone with that role straight away." />
    </>
  );
}
