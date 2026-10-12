import { Link } from 'react-router'
import { timesheetHref } from '../../domain/projects'

/** v5 "Timesheet" button on a project card: opens My timesheet limited to this project. */
export function TimesheetLink({ projectId, name, className = '' }: { projectId: string; name: string; className?: string }) {
  return (
    <Link
      to={timesheetHref(projectId, name)}
      title="Timesheet for this project"
      onClick={e => e.stopPropagation()}
      className={`relative z-10 inline-flex h-7 flex-none items-center gap-1.5 whitespace-nowrap rounded-[8px] border-[1.5px] border-line bg-white px-2.5 text-[12.5px] font-bold text-ink no-underline hover:border-blue hover:text-blue-ink ${className}`}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v4l3 2" />
      </svg>
      Timesheet
    </Link>
  )
}
