import { StyleSheet, View } from 'react-native';

import { Avatar, Card, CompanyLogo, EmptyState, Eyebrow, Icon, Press, Screen, Txt } from '@/components';
import { showToast } from '@/components/Toast';
import { hm } from '@/data/format';
import { companyByName, projectsOfCompany } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Contact, PortalPerm } from '@/data/types';
import { href, push } from '@/nav/routes';
import { colors, radii, space } from '@/theme';

import { companyProjectStatus } from './selectors';

const PERMS: PortalPerm[] = ['Board', 'Timeline', 'Questions', 'Bugs'];

/** S-COMPANY: header, projects, contacts with portal permissions, archive/restore (M-40). */
export function CompanyScreen({ name }: { name: string }) {
  const company = useAppState((s) => companyByName(s, name));
  const projects = useAppState((s) => projectsOfCompany(s, name));
  const { toggleCompanyArchived } = useActions();

  if (!company) {
    return (
      <Screen title={name} testID="screen-company">
        <EmptyState icon="building-2" text="This company no longer exists." />
      </Screen>
    );
  }
  return (
    <Screen title={company.name} gap={space.gap.detail} contentStyle={styles.content} testID="screen-company">
      <Card pad={16} style={styles.head}>
        <CompanyLogo company={company.name} size={48} radius={12} />
        <View style={styles.flex}>
          <Txt v="titleCard">{company.name}</Txt>
          <Txt v="meta" w={400} color={colors.ink3}>{`${hm(company.hoursThisMonth)} logged this month`}</Txt>
        </View>
      </Card>

      <Eyebrow style={styles.eyebrow}>Projects</Eyebrow>
      {projects.length ? (
        <View style={styles.card} testID="company-projects">
          {projects.map((p, i) => {
            const st = companyProjectStatus(p);
            return (
              <Press
                key={p.name}
                label={`${p.name}, ${st} ${p.pct}%`}
                onPress={() => push(href.project(p.name))}
                scale={1}
                style={[styles.projRow, i > 0 && styles.divider]}
                testID={`company-project-${p.name}`}
              >
                <Icon name="folder-kanban" size={18} color={colors.violetInk} />
                <Txt v="bodyLg" w={700} style={styles.flex} numberOfLines={1}>
                  {p.name}
                </Txt>
                <Txt v="caption" w={700} color={colors.ink3}>{`${st} · ${p.pct}%`}</Txt>
                <Icon name="chevron-right" size={16} color={colors.muted} />
              </Press>
            );
          })}
        </View>
      ) : (
        <EmptyState icon="folder-kanban" text="No projects yet." />
      )}

      {company.contacts.length ? (
        <>
          <Eyebrow style={styles.eyebrow}>Contacts & portal access</Eyebrow>
          {company.contacts.map((c) => (
            <ContactCard key={c.name} company={company.name} c={c} />
          ))}
        </>
      ) : null}

      <Press
        label={company.archived ? 'Restore company' : 'Archive company'}
        onPress={() => showToast(toggleCompanyArchived(company.name))}
        scale={0.97}
        style={styles.archBtn}
        testID="company-archive"
      >
        <Txt v="bodyLg" w={700} color={company.archived ? colors.primaryInk : colors.danger}>
          {company.archived ? 'Restore company' : 'Archive company'}
        </Txt>
      </Press>
    </Screen>
  );
}

function ContactCard({ company, c }: { company: string; c: Contact }) {
  const { setPortalPerm } = useActions();
  return (
    <Card style={styles.contact} testID={`contact-${c.name}`}>
      <View style={styles.contactHead}>
        <Avatar name={c.name} size={36} radius={18} initialsOnly bg={colors.ink} />
        <View style={styles.flex}>
          <Txt v="rowTitle" w={800}>
            {c.name}
          </Txt>
          <Txt v="caption" color={colors.ink3} numberOfLines={1}>{`${c.role} · ${c.email}`}</Txt>
        </View>
      </View>
      <View style={styles.perms}>
        {PERMS.map((pm) => {
          const on = c.portal[pm];
          return (
            <Press
              key={pm}
              label={`${pm} access for ${c.name}`}
              a11yRole="checkbox"
              checked={on}
              onPress={() => setPortalPerm(company, c.name, pm, !on)}
              scale={0.97}
              style={[styles.perm, on ? styles.permOn : styles.permOff]}
              testID={`perm-${c.name}-${pm}`}
            >
              <Icon name={on ? 'check' : 'plus'} size={14} color={on ? colors.primaryInk : colors.muted} strokeWidth={2.4} />
              <Txt v="caption" w={700} color={on ? colors.primaryInk : colors.muted}>
                {pm}
              </Txt>
            </Press>
          );
        })}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1, minWidth: 0 },
  eyebrow: { paddingHorizontal: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  projRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  contact: { gap: 10 },
  contactHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perms: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  perm: { height: 32, paddingLeft: 9, paddingRight: 12, borderRadius: 16, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 5 },
  permOn: { backgroundColor: colors.primarySoft2, borderColor: colors.primary },
  permOff: { backgroundColor: colors.stepper, borderColor: colors.line },
  archBtn: {
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
