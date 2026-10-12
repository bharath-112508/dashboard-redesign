import { useLocalSearchParams } from 'expo-router';

import { NewRequestSheet } from '@/features/devops/NewRequestSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWREQ Send request (URL sheet `devops-request`). */
export default function DevopsRequestSheetRoute() {
  const { key } = useLocalSearchParams<SheetQuery<'devops-request'>>();
  return <NewRequestSheet dvKey={key ?? ''} />;
}
