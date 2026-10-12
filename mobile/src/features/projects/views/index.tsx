import type { ProjectView } from '@/data/store';

import { ReportView, SupportView } from './MaintViews';
import { BoardView, EpicsView, FilesView, ListView, TimelineView } from './TicketViews';

/** The body of the selected project view. */
export function ProjectViewBody({ view, project }: { view: ProjectView; project: string }) {
  switch (view) {
    case 'list':
      return <ListView project={project} />;
    case 'board':
      return <BoardView project={project} />;
    case 'tree':
      return <EpicsView project={project} />;
    case 'tl':
      return <TimelineView project={project} />;
    case 'files':
      return <FilesView project={project} />;
    case 'sup':
      return <SupportView project={project} />;
    case 'rep':
      return <ReportView project={project} />;
  }
}
