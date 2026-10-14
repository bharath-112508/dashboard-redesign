import { Types } from 'mongoose';
import { listCustomStatuses, listProjectMembers, listProjects, type ProjectCaller } from './project.service.js';
import { listStories } from './story.service.js';
import { listSprints } from './sprint.service.js';
import { listTasks } from './task.service.js';
import { listCompanies, listRepresentatives } from './company.service.js';
import { listProjectsQuerySchema } from '../validators/project.validator.js';
import { listStoriesQuerySchema } from '../validators/story.validator.js';
import { listSprintsQuerySchema } from '../validators/sprint.validator.js';
import { listTasksQuerySchema } from '../validators/task.validator.js';
import { listCompaniesQuerySchema, listRepresentativesQuerySchema } from '../validators/company.validator.js';
import logger from '../utils/logger.js';

/**
 * Redesign: the board and the companies page in one request each, instead of
 * about five per project. Each part comes from the same service function and
 * query its own route uses, so the rows, their visibility and their shape are
 * exactly what the per-project routes return.
 */

const PAGE = 100;

/** Every row of a paged list, a page at a time. */
const everyPage = async <T>(read: (page: number) => Promise<{ data: T[] }>): Promise<T[]> => {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
        const { data } = await read(page);
        rows.push(...data);
        if (data.length < PAGE) return rows;
    }
};

/** A few at a time (each project reads five lists), so one load uses a small share of the connection pool. */
const inBatches = async <T, R>(items: T[], fn: (item: T) => Promise<R>, size = 4): Promise<R[]> => {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    return out;
};

type Row = Record<string, unknown>;
const idOf = (row: Row) => new Types.ObjectId(String(row.id));

const liveProjects = async (caller: ProjectCaller) =>
    (await everyPage((page) => listProjects(listProjectsQuerySchema.parse({ page, limit: PAGE }), caller))).filter((p) => !p.is_archived);

const storiesOf = (id: Types.ObjectId, caller: ProjectCaller) =>
    everyPage((page) => listStories(id, listStoriesQuerySchema.parse({ page, limit: PAGE }), caller));

/** Every live project the caller can see, with its epics, sprints, statuses, members and tickets. */
export const loadBoard = async (caller: ProjectCaller) => {
    const rows = await inBatches(await liveProjects(caller), async (project) => {
        const id = idOf(project);
        try {
            const [stories, sprints, statuses, members, tasks] = await Promise.all([
                storiesOf(id, caller),
                everyPage((page) => listSprints(id, listSprintsQuerySchema.parse({ page, limit: PAGE }), caller)),
                listCustomStatuses(id, caller),
                listProjectMembers(id, caller),
                everyPage((page) => listTasks(listTasksQuerySchema.parse({ project_id: String(id), page, limit: PAGE }), caller)),
            ]);
            return { project, stories, sprints, statuses, members, tasks };
        } catch (err) {
            // One project that can't be read (archived meanwhile, or refused) is left out, not the whole board.
            logger.warn({ err, project_id: String(id) }, 'BOARD_PROJECT_SKIPPED');
            return null;
        }
    });
    return rows.filter((r): r is NonNullable<typeof r> => r !== null);
};

/**
 * The companies page's details: each company project's epics, and (when the caller may
 * list them) each company's contacts. A part that can't be read is left out.
 */
export const loadCompanyDetails = async (caller: ProjectCaller, mayListContacts: boolean) => {
    const projects = (await liveProjects(caller)).filter((p) => p.company_id);
    const stories = Object.fromEntries(
        await inBatches(projects, async (p) => [String(p.id), await storiesOf(idOf(p), caller).catch(() => [])] as const)
    );
    if (!mayListContacts) return { stories, contacts: {} };
    const companies = await everyPage((page) => listCompanies(listCompaniesQuerySchema.parse({ page, limit: PAGE }), caller));
    const contacts = Object.fromEntries(
        (
            await inBatches(companies, async (c) => {
                const people = await everyPage((page) =>
                    listRepresentatives(idOf(c), listRepresentativesQuerySchema.parse({ page, limit: PAGE }), caller)
                ).catch((err: unknown) => {
                    logger.warn({ err, company_id: String(c.id) }, 'COMPANY_CONTACTS_SKIPPED');
                    return null;
                });
                return [String(c.id), people] as const;
            })
        ).filter(([, people]) => people !== null)
    );
    return { stories, contacts };
};
