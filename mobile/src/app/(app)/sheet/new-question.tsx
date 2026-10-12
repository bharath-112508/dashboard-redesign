import { useLocalSearchParams } from 'expo-router';

import { NewQuestionSheet } from '@/features/client/NewQuestionSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWQ Raise to client (URL sheet `new-question`). */
export default function NewQuestionSheetRoute() {
  const { pid, title } = useLocalSearchParams<SheetQuery<'new-question'>>();
  return <NewQuestionSheet pid={pid ?? ''} title={title} />;
}
