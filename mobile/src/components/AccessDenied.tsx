import { ACCESS_DENIED } from '@/nav/access';

import { EmptyBlock } from './EmptyBlock';

/** The state a guarded route shows for a role without access (A-4). */
export function AccessDenied() {
  return <EmptyBlock text={ACCESS_DENIED} testID="access-denied" />;
}
