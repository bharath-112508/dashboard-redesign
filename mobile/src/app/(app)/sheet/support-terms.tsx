import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-SUPTERMS Support terms (URL sheet `support-terms`) — placeholder; W2 replaces this body. */
export default function SupportTermsSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'support-terms'>>();
  return <PlaceholderSheet spec="SH-SUPTERMS Support terms" owner="W2" title="Support terms" id="support-terms" params={params} />;
}
