import { DEVOPS_SEED, DEVOPS_SETTINGS_SEED } from '../seed/devops';
import { MAINTENANCE_SEED } from '../seed/maintenance';
import { PEOPLE_SEED } from '../seed/people';
import { COMPANIES_SEED, PROJECTS_SEED } from '../seed/projects';
import { TICKETS_SEED } from '../seed/tickets';
import { ENTRIES_SEED, LEAVES_SEED, QUESTIONS_SEED } from '../seed/work';
import type {
  Company,
  DevopsProject,
  DevopsSettings,
  Leave,
  MaintData,
  Person,
  Project,
  Question,
  Ticket,
  TimeEntry,
} from '../types';

export type TicketFilter = 'open' | 'done' | 'all';
export type ProjectFilter = 'active' | 'maint' | 'done';
/** Building: list board tree tl files. Maintenance: sup rep list board files. */
export type ProjectView = 'list' | 'board' | 'tree' | 'tl' | 'files' | 'sup' | 'rep';

/**
 * Persisted UI preferences (prototype keys in brackets). Screens read and write these
 * with `setUi` so a choice survives navigation and reloads.
 */
export interface UiPrefs {
  /** [tFilter] Tickets tab filter */
  ticketFilter: TicketFilter;
  /** [weekOff] Timesheet week offset (0 = this week, −1 = last week) */
  weekOffset: number;
  /** [dayOpen] expanded Timesheet day (ISO) */
  dayOpen: string | null;
  /** [pf] Projects tab filter */
  projectFilter: ProjectFilter;
  /** [projView] view per project (DECISIONS.md 5: remembered per project) */
  projectView: Record<string, ProjectView>;
  /** [repM] report month per project */
  reportMonth: Record<string, string>;
  /** [epOpen] "project|epic" → open */
  epicOpen: Record<string, boolean>;
  /** [spOpen] "project|epic|sprint" → open */
  sprintOpen: Record<string, boolean>;
  /** [dvOpen] DevOps card expanded per project */
  devopsOpen: Record<string, boolean>;
  /** [bp, be, bv] Ticket board */
  boardProject: string | null;
  boardEpic: string;
  boardView: 'board' | 'list';
  /** [hf, hp] Time history filters */
  historyFilter: 'all' | 'bill' | 'non';
  historyProject: string;
  /** [teamOff] Team hours week offset */
  teamOffset: number;
  /** [showArch] Companies tab */
  showArchived: boolean;
}

export const DEFAULT_UI: UiPrefs = {
  ticketFilter: 'open',
  weekOffset: 0,
  dayOpen: null,
  projectFilter: 'active',
  projectView: {},
  reportMonth: {},
  epicOpen: {},
  sprintOpen: {},
  devopsOpen: {},
  boardProject: null,
  boardEpic: 'all',
  boardView: 'board',
  historyFilter: 'all',
  historyProject: 'all',
  teamOffset: 0,
  showArchived: false,
};

export interface Session {
  /** signed-in person's name, null when signed out */
  user: string | null;
  /** email draft on the Sign in screen (kept on Switch account, cleared on Sign out) */
  email: string;
}

export interface AppState {
  /** bump when the persisted shape changes; older saves are discarded */
  version: number;
  session: Session;
  people: Person[];
  tickets: Ticket[];
  questions: Question[];
  leaves: Leave[];
  entries: TimeEntry[];
  companies: Company[];
  projects: Project[];
  /** project name → maintenance data (requests, tasks, environments, releases) */
  maintenance: Record<string, MaintData>;
  devops: DevopsProject[];
  devopsSettings: DevopsSettings;
  /** notification id → read */
  read: Record<string, true>;
  /** Profile push toggle (no other effect, DECISIONS.md 6) */
  push: boolean;
  ui: UiPrefs;
  /** id counter for entries and leave (prototype nextId) */
  nextId: number;
}

export const STATE_VERSION = 1;

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A fresh state built from the seeds. */
export function createInitialState(): AppState {
  return {
    version: STATE_VERSION,
    session: { user: null, email: '' },
    people: clone(PEOPLE_SEED),
    tickets: clone(TICKETS_SEED),
    questions: clone(QUESTIONS_SEED),
    leaves: clone(LEAVES_SEED),
    entries: clone(ENTRIES_SEED),
    companies: clone(COMPANIES_SEED),
    projects: clone(PROJECTS_SEED),
    maintenance: clone(MAINTENANCE_SEED),
    devops: clone(DEVOPS_SEED),
    devopsSettings: clone(DEVOPS_SETTINGS_SEED),
    read: {},
    push: true,
    ui: clone(DEFAULT_UI),
    nextId: 100,
  };
}
