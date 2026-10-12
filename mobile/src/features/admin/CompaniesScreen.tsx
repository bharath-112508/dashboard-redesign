import { useState } from 'react';

import { CompanyTile } from '@/components/Avatar';
import { Row, Rows } from '@/components/Row';
import { Screen } from '@/components/Screen';
import { SearchField } from '@/components/SearchField';
import { Segmented } from '@/components/Segmented';
import { myPerm } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, openSheet, push } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { filterCompanies } from './admin';

/** S5-COMPANIES: search, Active / Archived, rows; "+" with `companies.edit` (V-80). */
export function CompaniesScreen() {
  const root = useRootActions();
  const companies = useAppState((s) => s.companies);
  const projects = useAppState((s) => s.projects);
  const canEdit = useAppState((s) => myPerm(s, 'companies.edit'));
  const [q, setQ] = useState('');
  const [v, setV] = useState<'active' | 'archived'>('active');
  const L = filterCompanies(companies, q, v === 'archived');
  const actions = [...(canEdit ? [{ icon: 'plus' as const, label: 'New company', onPress: () => openSheet('company'), testID: 'companies-add' }] : []), ...root];
  return (
    <Screen title="Companies" sub="Workspace" actions={actions} testID="screen-companies">
      <SearchField value={q} onChange={setQ} placeholder="Search companies" testID="companies-search" />
      <Segmented
        options={[
          { value: 'active', label: 'Active', count: companies.filter((c) => !c.archived).length },
          { value: 'archived', label: 'Archived', count: companies.filter((c) => c.archived).length || undefined },
        ]}
        value={v}
        onChange={setV}
        testID="companies-seg"
      />
      <Rows empty="No companies match your search." testID="companies-list">
        {L.map((c) => {
          const P = projects.filter((p) => p.kind === 'client' && p.companyId === c.id);
          const ap = P.filter((p) => p.state !== 'done').length;
          return (
            <Row
              key={c.id}
              lead={<CompanyTile name={c.name} logo={c.logo} />}
              title={c.name}
              sub={[c.industry, c.country].filter(Boolean).join(' · ')}
              right={P.length ? `${P.length} project${P.length > 1 ? 's' : ''}` : 'No projects yet'}
              meta={[{ icon: 'users', text: `${c.contacts.length} contacts` }, ap ? { icon: 'activity', text: `${ap} active`, color: colors.primaryInk } : null]}
              onPress={() => push(href.company(c.id))}
              testID={`company-row-${c.id}`}
            />
          );
        })}
      </Rows>
    </Screen>
  );
}
