import { useLocalSearchParams } from 'expo-router';

import { SupportTermsSheet } from '@/features/projects/sheets/SupportTermsSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-SUPTERMS Support terms (URL sheet `support-terms`, `{id}`). */
export default function SupportTermsSheetRoute() {
  const { id } = useLocalSearchParams<SheetQuery<'support-terms'>>();
  return <SupportTermsSheet id={id ?? ''} />;
}
