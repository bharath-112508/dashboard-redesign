import type { ProjectTab } from '@/nav/routes';

import type { ListFilter } from '../derive';

/** Switch the project tab, optionally with a List status filter or a Board epic (V-43). */
export type Jump = (tab: ProjectTab, opts?: { st?: ListFilter; epic?: string }) => void;
