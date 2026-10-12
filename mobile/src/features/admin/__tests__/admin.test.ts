import { describe, expect, it } from '@jest/globals';

import { harness } from '@/data/__tests__/helpers';

import { accessFrom, filterCompanies, filterUsers, userSub } from '../admin';

describe('users', () => {
  it('filters by search, org and role', () => {
    const P = harness(1).get().people;
    expect(filterUsers(P, '', 'vt', 'all')).toHaveLength(6);
    expect(filterUsers(P, '', 'client', 'all')).toHaveLength(4);
    expect(filterUsers(P, '', 'all', 'dev').map((p) => p.name)).toEqual(['Chary', 'Sofia']);
    expect(filterUsers(P, 'DACO.no', 'all', 'all').map((p) => p.name)).toEqual(['Ingrid Solberg', 'Lars Moen']);
    expect(userSub(P.find((p) => p.name === 'Sofia')!)).toBe('sofia@freelance.dev · Frontend · Freelancer');
  });
  it('project access from the multi pick', () => {
    expect(accessFrom(['dacop', 'all'])).toBe('all');
    expect(accessFrom(['dacop'])).toEqual(['dacop']);
  });
  it('duplicate email, add and edit (V-71); deactivated cannot sign in (V-72)', () => {
    const h = harness(2);
    expect(h.cmd.saveUser({ name: 'X', email: 'CHARY@viljetech.com', role: 'dev' })).toMatchObject({ ok: false, error: 'Someone already uses that email' });
    const r = h.cmd.saveUser({ name: 'Nina', email: 'nina@viljetech.com', role: 'dev', emp: 'freelancer', projects: ['dacop'] });
    expect(r).toMatchObject({ ok: true, toast: 'Invite sent to nina@viljetech.com' });
    expect(h.cmd.saveUser({ id: 3, name: 'Chary', email: 'chary@viljetech.com', role: 'dev' })).toMatchObject({ ok: true, toast: 'User saved' });
    expect(h.cmd.setUserActive(3, false)).toMatchObject({ toast: 'User deactivated' });
    expect(h.cmd.signIn('chary@viljetech.com', 'demo')).toMatchObject({ ok: false });
  });
  it('profile password rules (V-04)', () => {
    const h = harness(1);
    expect(h.cmd.saveProfile({ name: ' ' })).toMatchObject({ ok: false, error: 'Add your name' });
    expect(h.cmd.saveProfile({ name: 'R', password: 'short', repeat: 'short' })).toMatchObject({ ok: false, error: 'Password needs at least 8 characters' });
    expect(h.cmd.saveProfile({ name: 'R', password: 'longenough', repeat: 'other' })).toMatchObject({ ok: false, error: 'Passwords do not match' });
    expect(h.cmd.saveProfile({ name: 'Rahul S', password: 'longenough', repeat: 'longenough' })).toMatchObject({ ok: true, toast: 'Profile saved' });
    expect(h.get().people[0].name).toBe('Rahul S');
  });
});

describe('companies', () => {
  it('filters active / archived by name', () => {
    const h = harness(1);
    expect(filterCompanies(h.get().companies, 'nord', false).map((c) => c.id)).toEqual(['nord']);
    h.cmd.setCompanyArchived('hav', true);
    expect(filterCompanies(h.get().companies, '', true).map((c) => c.id)).toEqual(['hav']);
  });
});
