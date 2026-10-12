import { Placeholder, type PlaceholderLink } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { href, sheetHref } from '@/nav/routes';
import { homeVariant } from '@/nav/tabs';

/** Every pushed route and sheet, so the shell can be clicked through before P1–P4 land. */
const ROUTES: PlaceholderLink[] = [
  { label: 'Ticket PMT-11', href: href.ticket(1) },
  { label: 'Question 1', href: href.question(1) },
  { label: 'Project Daco platform', href: href.project('Daco platform') },
  { label: 'Company Daco', href: href.company('Daco') },
  { label: 'User Chary', href: href.user('Chary') },
  { label: 'Notifications', href: href.inbox() },
  { label: 'Profile', href: href.me() },
  { label: 'Leave', href: href.leave() },
  { label: 'Team hours', href: href.team() },
  { label: 'Companies', href: href.companies() },
  { label: 'Users', href: href.users() },
  { label: 'DevOps settings', href: href.dvset() },
  { label: 'Time history', href: href.history() },
  { label: 'Ticket board', href: href.board() },
  { label: 'Projects (pushed)', href: href.stack('projects') },
  { label: 'DevOps (pushed)', href: href.stack('devops') },
  { label: 'Tickets (pushed)', href: href.stack('tickets') },
  { label: 'Sheet: Log time', href: sheetHref('log-time') },
  { label: 'Sheet: Report', href: sheetHref('report') },
  { label: 'Sheet: Leave', href: sheetHref('leave') },
  { label: 'Sheet: Project status', href: sheetHref('project-status', { project: 'Daco platform' }) },
  { label: 'Sheet: Support plan', href: sheetHref('support-plan', { project: 'Daco intranet' }) },
];

/**
 * S-HOME (tab root). The Home layout depends on the role: homeVariant(role) →
 * 'ic' (dev, free) | 'staffAll' (pm, admin, super) | 'devops' | 'client'.
 * Placeholder: P1 replaces this file (src/app/(app)/(tabs)/home.tsx).
 */
export default function HomeTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-HOME"
      title="Home"
      owner="P1"
      file="src/app/(app)/(tabs)/home.tsx"
      header="large"
      params={{ layout: homeVariant(role) }}
      links={ROUTES}
      testID="screen-home"
    />
  );
}
