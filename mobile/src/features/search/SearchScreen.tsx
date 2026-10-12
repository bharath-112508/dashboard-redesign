import { useMemo, useState } from 'react';

import { Avatar, Block, CompanyTileById, EmptyBlock, IconTile, ProjectTile, Row, Rows, Screen, SearchField, TextBlock, TicketRow } from '@/components';
import { plural } from '@/data/format';
import { myRole } from '@/data/selectors';
import { useStoreState } from '@/data/store';
import { href, push, tab2 } from '@/nav/routes';
import { colors } from '@/theme';

import { hitCount, searchAll } from './search';

/** S5-SEARCH Search (V-06): pages, tickets, projects, DevOps (by project name), companies, people. */
export function SearchScreen() {
  const s = useStoreState();
  const role = myRole(s);
  const [q, setQ] = useState('');
  const r = useMemo(() => searchAll(s, role, q), [s, role, q]);
  const query = q.trim();
  return (
    <Screen title="Search" testID="screen-search">
      <SearchField value={q} onChange={setQ} placeholder="Search pages, tickets, projects, companies, people" autoFocus testID="search-field" />
      {!query ? <TextBlock tone="info" text="Search pages, tickets, projects, companies and people." /> : null}
      {r.pages.length ? (
        <Block title="Pages" testID="search-pages">
          <Rows>
            {r.pages.map((x) => (
              <Row
                key={x.key}
                lead={<IconTile icon={x.icon} bg={colors.track} fg={colors.primaryInk} />}
                title={x.label}
                sub="Open page"
                onPress={() => tab2(x.key, role)}
                testID={`search-page-${x.key}`}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {r.tickets.length ? (
        <Block title="Tickets" testID="search-tickets">
          <Rows>
            {r.tickets.map((t) => (
              <TicketRow key={t.key} ticket={t} />
            ))}
          </Rows>
        </Block>
      ) : null}
      {r.projects.length ? (
        <Block title="Projects" testID="search-projects">
          <Rows>
            {r.projects.map((p) => (
              <Row key={p.id} lead={<ProjectTile id={p.id} />} title={p.name} sub={p.co} onPress={() => push(href.project(p.id))} testID={`search-project-${p.id}`} />
            ))}
          </Rows>
        </Block>
      ) : null}
      {r.devops.length ? (
        <Block title="DevOps board" testID="search-devops">
          <Rows>
            {r.devops.map((d) => (
              <Row
                key={d.key}
                lead={<ProjectTile id={d.projectId} />}
                title={d.name}
                sub={`${d.key} · ${d.company} · ${d.infra}`}
                onPress={() => push(href.dvp(d.key))}
                testID={`search-devops-${d.key}`}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {r.companies.length ? (
        <Block title="Companies" testID="search-companies">
          <Rows>
            {r.companies.map((c) => (
              <Row
                key={c.id}
                lead={<CompanyTileById id={c.id} />}
                title={c.name}
                sub={plural(s.projects.filter((p) => p.companyId === c.id).length, 'project')}
                onPress={() => push(href.company(c.id))}
                testID={`search-company-${c.id}`}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {r.people.length ? (
        <Block title="People" testID="search-people">
          <Rows>
            {r.people.map((u) => (
              <Row key={u.id} lead={<Avatar name={u.name} />} title={u.name} sub={u.email} onPress={() => push(href.user(u.id))} testID={`search-person-${u.id}`} />
            ))}
          </Rows>
        </Block>
      ) : null}
      {query && !hitCount(r) ? <EmptyBlock text={`No results for “${query}”`} testID="search-empty" /> : null}
    </Screen>
  );
}
