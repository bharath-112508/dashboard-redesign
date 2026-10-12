import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-PROJSTATUS Project status (URL sheet `project-status`) — placeholder; W2 replaces this body. */
export default function ProjectStatusSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'project-status'>>();
  return <PlaceholderSheet spec="SH-PROJSTATUS Project status" owner="W2" title="Project status" id="project-status" params={params} />;
}
