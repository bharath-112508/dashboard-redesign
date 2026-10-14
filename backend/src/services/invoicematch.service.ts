import { Types } from 'mongoose';
import { InvoicematchDecision } from '../models/invoicematch-decision.model.js';
import { Project } from '../models/project.model.js';
import { nameOf, visibleProjectIds } from './devops.service.js';
import { AppError } from '../utils/app-error.js';
import { recordAudit } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import type { ProjectCaller } from './project.service.js';

/**
 * Redesign: decisions in the InvoiceMatch live-app demo. The team and the
 * clients who can see the project (named InvoiceMatch) may read and decide.
 */

const IM_NAME = 'InvoiceMatch';

type Decision = { no: string; st: 'approved' | 'hold' | 'rejected'; note: string; by: string };

/** The project id, if it is an InvoiceMatch project the caller may see; otherwise not found. */
const loadProject = async (projectId: string, caller: ProjectCaller): Promise<Types.ObjectId> => {
    const p = Types.ObjectId.isValid(projectId)
        ? await Project.findById(projectId).select('_id name is_archived').lean<{ _id: Types.ObjectId; name: string; is_archived?: boolean } | null>()
        : null;
    const ids = p ? await visibleProjectIds(caller) : null;
    if (!p || p.name !== IM_NAME || p.is_archived || (ids && !ids.some((id) => id.equals(p._id)))) throw AppError.notFound('That live app does not exist.');
    return p._id;
};

const audit = async (caller: ProjectCaller, project_id: Types.ObjectId, after: unknown) => {
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.INVOICEMATCH_DECIDE,
            target: { kind: AUDIT_TARGET_KINDS.INVOICEMATCH_DECISION, id: project_id },
            after,
        } as never);
    }
};

const toPublic = ({ no, st, note, by }: Decision): Decision => ({ no, st, note, by });

export const listDecisions = async (projectId: string, caller: ProjectCaller): Promise<Decision[]> => {
    const project_id = await loadProject(projectId, caller);
    const rows = await InvoicematchDecision.find({ project_id }).select('no st note by').lean<Decision[]>();
    return rows.map(toPublic);
};

export const decide = async (projectId: string, no: string, body: { st: Decision['st']; note: string }, caller: ProjectCaller) => {
    const project_id = await loadProject(projectId, caller);
    const set = { $set: { st: body.st, note: body.note, by: await nameOf(caller.id), by_id: caller.id } };
    const save = (upsert: boolean) => InvoicematchDecision.findOneAndUpdate({ project_id, no }, set, { upsert, new: true }).lean<Decision>();
    // Two first decisions at once: the unique index refuses the second insert, which then updates the row the first made.
    const row = await save(true).catch((err: { code?: number }) => {
        if (err.code === 11000) return save(false);
        throw err;
    });
    await audit(caller, project_id, { no, st: body.st });
    return toPublic(row!);
};

export const undo = async (projectId: string, no: string, caller: ProjectCaller) => {
    const project_id = await loadProject(projectId, caller);
    await InvoicematchDecision.deleteOne({ project_id, no });
    await audit(caller, project_id, { no, st: null });
    return { no };
};
