import { Types } from 'mongoose';
import { DevopsItem, type DevopsItemDocument } from '../models/devops-item.model.js';
import { Project } from '../models/project.model.js';
import { User } from '../models/user.model.js';
import { getOrInitSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { CLIENT_SIDE_ROLES, ROLES } from '../constants/roles.js';
import { AppError } from '../utils/app-error.js';
import { isAdminLike } from '../utils/role-check.js';
import type { ProjectCaller } from './project.service.js';

/**
 * Redesign: the DevOps board. Items and settings keep the app's own fields;
 * the backend decides who may read and write them, keeps locked dates locked
 * and writes who changed what.
 */

type Data = Record<string, unknown>;

export const isClientCaller = (caller: ProjectCaller) => CLIENT_SIDE_ROLES.includes(caller.role);

/** Admins and people with the DevOps role run the board. */
export const canRunDevops = (caller: ProjectCaller) => isAdminLike(caller) || (caller.role_keys ?? []).includes('devops');

/**
 * The projects a caller may see DevOps data for: null (all) for staff; for a
 * client their company's projects, for a representative only the ones they are on.
 */
export const visibleProjectIds = async (caller: ProjectCaller): Promise<Types.ObjectId[] | null> => {
    if (!isClientCaller(caller)) return null;
    if (!caller.company_id) return [];
    const filter =
        caller.role === ROLES.REPRESENTATIVE
            ? { company_id: caller.company_id, representative_ids: caller.id }
            : { company_id: caller.company_id };
    const rows = await Project.find(filter).select('_id').lean<{ _id: Types.ObjectId }[]>();
    return rows.map((r) => r._id);
};

/** The caller's name, as the app shows authors. */
export const nameOf = async (id: Types.ObjectId): Promise<string> => {
    const u = await User.findById(id).select('full_name').lean<{ full_name?: string } | null>();
    return u?.full_name ?? 'Someone';
};

/** The fields of an item a client may see: its status side, not the team's notes, activity, owners or plans. */
const CLIENT_ITEM_FIELDS = ['name', 'project', 'kind', 'infra', 'infraNote', 'phase', 'deploy', 'depType', 'initDue', 'latestDue', 'added', 'deploys'];

export const toPublicItem = (d: Pick<DevopsItemDocument, 'key' | 'project_id' | 'data' | 'updated_at'>, forClient = false) => {
    const data = d.data ?? {};
    return {
        key: d.key,
        project_id: String(d.project_id),
        data: forClient ? Object.fromEntries(CLIENT_ITEM_FIELDS.filter((k) => k in data).map((k) => [k, data[k]])) : data,
        updated_at: d.updated_at,
    };
};

const audit = async (caller: ProjectCaller, action: string, kind: string, id: Types.ObjectId, after: unknown) => {
    if (caller.audit) await recordAudit(caller.audit, { action, target: { kind, id }, after } as never);
};

// ─── Items ──────────────────────────────────────────────────────────────

export const listItems = async (caller: ProjectCaller) => {
    const ids = await visibleProjectIds(caller);
    const rows = await DevopsItem.find(ids ? { project_id: { $in: ids } } : {})
        .sort({ created_at: -1 })
        .lean<DevopsItemDocument[]>();
    return rows.map((r) => toPublicItem(r, ids !== null));
};

export const createItem = async (body: { key: string; project_id: string; data: Data }, caller: ProjectCaller) => {
    if (!canRunDevops(caller)) throw AppError.forbidden('Only DevOps and admins add DevOps items.');
    const project = await Project.findById(body.project_id).select('_id').lean<{ _id: Types.ObjectId } | null>();
    if (!project) throw AppError.notFound('That project does not exist.');
    if (await DevopsItem.findOne({ key: body.key }).select('_id').lean()) {
        throw AppError.conflict('Someone else just added one with that key. Try again.');
    }
    const doc = await DevopsItem.create({
        key: body.key,
        project_id: project._id,
        data: body.data,
        created_by: caller.id,
        updated_by: caller.id,
    }).catch((err: { code?: number }) => {
        // Two people took the same key at once: the unique index refuses the second.
        throw err.code === 11000 ? AppError.conflict('Someone else just added one with that key. Try again.') : err;
    });
    await audit(caller, AUDIT_ACTIONS.DEVOPS_ITEM_CREATE, AUDIT_TARGET_KINDS.DEVOPS_ITEM, doc._id, { key: body.key });
    return toPublicItem(doc);
};

/** The app's lock rules: a saved initial due date and saved dev phase due dates never change. */
export const applyLocks = (cur: Data, patch: Data, rules: { lockInitial?: boolean; lockDevDue?: boolean }): Data => {
    const out: Data = { ...patch };
    if (rules.lockInitial && cur.initDue && 'initDue' in out) out.initDue = cur.initDue;
    if (rules.lockDevDue) {
        const fixed = (cur.devDues ?? {}) as Record<string, string>;
        if (Object.keys(fixed).length || out.devDues) out.devDues = { ...((out.devDues as object) ?? {}), ...fixed };
        const phase = (out.dev ?? cur.dev) as string | undefined;
        const pinned = phase ? (out.devDues as Record<string, string> | undefined)?.[phase] : undefined;
        if (pinned && 'devDue' in out) out.devDue = pinned;
    }
    return out;
};

const rulesOf = async () => {
    const s = (await getOrInitSettings()).devops_settings as { rules?: { lockInitial?: boolean; lockDevDue?: boolean } } | null;
    // Until Settings are saved the app shows the design's defaults, which lock both.
    return s?.rules ?? { lockInitial: true, lockDevDue: true };
};

export const updateItem = async (
    key: string,
    body: { patch: Data; log?: { type: string; text: string; detail?: string } },
    caller: ProjectCaller
) => {
    if (!canRunDevops(caller)) throw AppError.forbidden('Only DevOps and admins change DevOps items.');
    const doc = await DevopsItem.findOne({ key });
    if (!doc) throw AppError.notFound('That DevOps item does not exist.');
    // The key and the linked project are fixed once the item exists.
    const { key: _k, project: _p, logs: _l, updatedBy: _u, ...patch } = body.patch;
    const by = await nameOf(caller.id);
    const cur = doc.data ?? {};
    const logs = (cur.logs as unknown[]) ?? [];
    doc.data = {
        ...cur,
        ...applyLocks(cur, patch, await rulesOf()),
        updatedBy: by,
        logs: body.log ? [{ ...body.log, by, when: new Date().toISOString() }, ...logs] : logs,
    };
    doc.updated_by = caller.id;
    doc.markModified('data');
    await doc.save();
    await audit(caller, AUDIT_ACTIONS.DEVOPS_ITEM_UPDATE, AUDIT_TARGET_KINDS.DEVOPS_ITEM, doc._id, { key, fields: Object.keys(patch) });
    return toPublicItem(doc);
};

// ─── Settings ───────────────────────────────────────────────────────────

export const getDevopsSettings = async (): Promise<Data | null> => (await getOrInitSettings()).devops_settings ?? null;

export const setDevopsSettings = async (settings: Data, caller: ProjectCaller): Promise<Data> => {
    if (!canRunDevops(caller)) throw AppError.forbidden('Only DevOps and admins change DevOps settings.');
    const s = await getOrInitSettings();
    s.devops_settings = settings;
    s.markModified('devops_settings');
    await s.save();
    await audit(caller, AUDIT_ACTIONS.DEVOPS_SETTINGS_UPDATE, AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, s._id, { devops_settings: true });
    return settings;
};
