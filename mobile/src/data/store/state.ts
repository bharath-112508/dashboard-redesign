import { DEFAULT_DEVOPS_SETTINGS, PDEF } from '../constants';
import {
  BUG_CHAT,
  BUGS,
  CLIENT_TEAM,
  COMPANIES,
  DEVOPS,
  DEVOPS_REQUESTS,
  ENTRIES,
  EPICS,
  LEAVE,
  PEOPLE,
  PROJECTS,
  QUESTIONS,
  SPRINTS,
  TICKETS,
} from '../seed';
import type {
  ClientBug,
  ClientTeamMember,
  Comment,
  Company,
  DevopsProject,
  DevopsRequest,
  DevopsSettings,
  Epic,
  FileRef,
  Leave,
  PermMatrix,
  Person,
  Project,
  Question,
  Session,
  Sprint,
  Ticket,
  TimeEntry,
} from '../types';

/** Bump when the persisted shape changes; other versions are dropped (DECISIONS 9). */
export const STATE_VERSION = 2;

/** The whole app state (DELTA D-DATA-25). Static seeds (DEPLOYS, demo numbers) are not in it. */
export interface AppState {
  version: typeof STATE_VERSION;
  session: Session;
  people: Person[];
  companies: Company[];
  projects: Project[];
  epics: Epic[];
  sprints: Sprint[];
  tickets: Ticket[];
  /** project files by project id */
  files: Record<string, FileRef[]>;
  entries: TimeEntry[];
  leaves: Leave[];
  perms: PermMatrix;
  questions: Question[];
  bugs: ClientBug[];
  bugChat: Record<string, Comment[]>;
  clientTeam: ClientTeamMember[];
  devops: DevopsProject[];
  devopsRequests: DevopsRequest[];
  devopsSettings: DevopsSettings;
  /** next numeric id (entries, leave, people, requests) */
  nextId: number;
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A fresh state from the v5 seed. */
export function createInitialState(): AppState {
  return clone({
    version: STATE_VERSION,
    session: { personId: null },
    people: PEOPLE,
    companies: COMPANIES,
    projects: PROJECTS,
    epics: EPICS,
    sprints: SPRINTS,
    tickets: TICKETS,
    files: {},
    entries: ENTRIES,
    leaves: LEAVE,
    perms: PDEF,
    questions: QUESTIONS,
    bugs: BUGS,
    bugChat: BUG_CHAT,
    clientTeam: CLIENT_TEAM,
    devops: DEVOPS,
    devopsRequests: DEVOPS_REQUESTS,
    devopsSettings: DEFAULT_DEVOPS_SETTINGS,
    nextId: 10000,
  } satisfies AppState);
}
