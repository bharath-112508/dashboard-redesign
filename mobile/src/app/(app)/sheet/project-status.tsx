import { useLocalSearchParams } from 'expo-router';

import { ProjectStatusSheet } from '@/features/projects/sheets/ProjectStatusSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-PROJSTATUS Project status (URL sheet `project-status`, `{id}`). */
export default function ProjectStatusSheetRoute() {
  const { id } = useLocalSearchParams<SheetQuery<'project-status'>>();
  return <ProjectStatusSheet id={id ?? ''} />;
}
