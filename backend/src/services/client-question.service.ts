import { Types } from 'mongoose';
import { ClientQuestion, type ClientQuestionDocument } from '../models/client-question.model.js';
import { DevopsRequest, type DevopsRequestDocument } from '../models/devops-request.model.js';
import { DevopsItem } from '../models/devops-item.model.js';
import { Sprint } from '../models/sprint.model.js';
import { Task } from '../models/task.model.js';
import { isClientCaller, nameOf, visibleProjectIds } from './devops.service.js';
import { recordAudit } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import type { ProjectCaller } from './project.service.js';

/**
 * Redesign: questions the team raises to clients, and requests the team
 * raises to DevOps. The team (every staff role) reads and writes all of them.
 * A client sees the ones on their company's projects, writes client messages
 * on their questions, edits their own messages and marks questions solved.
 */

type Data = Record<string, unknown>;
const isId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);

const teamOnly = (caller: ProjectCaller, what: string) => {
    if (isClientCaller(caller)) throw AppError.forbidden(`Clients cannot ${what}.`);
};

const taken = () => AppError.conflict('Someone else just added one with that number. Try again.');
/** A unique-index clash between the check and the insert is the same clash. */
const createOrConflict = async <T>(make: () => Promise<T>): Promise<T> => {
    try {
        return await make();
    } catch (err) {
        if ((err as { code?: number }).code === 11000) throw taken();
        throw err;
    }
};

const projectOfKey = async (key: string | null | undefined) =>
    key ? ((await DevopsItem.findOne({ key }).select('project_id').lean<{ project_id: Types.ObjectId } | null>())?.project_id ?? null) : null;

const audit = async (caller: ProjectCaller, action: string, kind: string, id: Types.ObjectId, after: unknown) => {
    if (caller.audit) await recordAudit(caller.audit, { action, target: { kind, id }, after } as never);
};

// ─── Questions ──────────────────────────────────────────────────────────

const toPublicQuestion = (d: ClientQuestionDocument) => ({
    number: d.number,
    project_id: d.project_id ? String(d.project_id) : null,
    task_id: d.task_id ? String(d.task_id) : null,
    devops_key: d.devops_key ?? null,
    sprint: d.sprint ?? null,
    title: d.title,
    text: d.text ?? '',
    photos: d.photos ?? [],
    qtype: d.qtype ?? '',
    qprio: d.qprio ?? '',
    from_devops: !!d.from_devops,
    by: d.by,
    solved: !!d.solved,
    seen_t: d.seen_t ?? 0,
    created_at: d.created_at,
    messages: (d.messages ?? []).map(({ who, side, text, files, when }) => ({ who, side, text, files: files ?? [], when })),
});

/** The question, if the caller may see it; otherwise not found (a client never learns it exists). */
const loadQuestion = async (number: number, caller: ProjectCaller) => {
    const d = await ClientQuestion.findOne({ number });
    const ids = d ? await visibleProjectIds(caller) : null;
    if (!d || (ids && !ids.some((id) => d.project_id && id.equals(d.project_id)))) throw AppError.notFound('That question does not exist.');
    return d;
};

export const listQuestions = async (caller: ProjectCaller) => {
    const ids = await visibleProjectIds(caller);
    const rows = await ClientQuestion.find(ids ? { project_id: { $in: ids } } : {})
        .sort({ number: 1 })
        .lean<ClientQuestionDocument[]>();
    return rows.map(toPublicQuestion);
};

export const createQuestion = async (body: Data & { number: number; title: string }, caller: ProjectCaller) => {
    teamOnly(caller, 'start questions');
    if (await ClientQuestion.findOne({ number: body.number }).select('_id').lean()) throw taken();
    const task = isId(body.task_id) ? await Task.findById(body.task_id).select('project_id').lean<{ project_id: Types.ObjectId } | null>() : null;
    const sprintId = typeof body.sprint === 'string' ? body.sprint.split('~')[0] : null;
    const sprint = !task && !body.devops_key && isId(sprintId)
        ? await Sprint.findById(sprintId).select('project_id').lean<{ project_id: Types.ObjectId } | null>()
        : null;
    const project_id = task?.project_id ?? (await projectOfKey(body.devops_key as string | undefined)) ?? sprint?.project_id ?? null;
    const by = await nameOf(caller.id);
    const doc = await createOrConflict(() =>
        ClientQuestion.create({ ...body, task_id: task ? (body.task_id as string) : null, project_id, by, by_id: caller.id, messages: [] } as Partial<ClientQuestionDocument>)
    );
    await audit(caller, AUDIT_ACTIONS.CLIENT_QUESTION_CREATE, AUDIT_TARGET_KINDS.CLIENT_QUESTION, doc._id, { number: body.number });
    return toPublicQuestion(doc);
};

const CLIENT_QUESTION_FIELDS = new Set(['solved']);

export const updateQuestion = async (number: number, patch: Data, caller: ProjectCaller) => {
    if (isClientCaller(caller) && !Object.keys(patch).every((k) => CLIENT_QUESTION_FIELDS.has(k))) {
        throw AppError.forbidden('Clients can only mark a question solved or reopen it.');
    }
    const d = await loadQuestion(number, caller);
    Object.assign(d, patch);
    await d.save();
    await audit(caller, AUDIT_ACTIONS.CLIENT_QUESTION_UPDATE, AUDIT_TARGET_KINDS.CLIENT_QUESTION, d._id, { number, fields: Object.keys(patch) });
    return toPublicQuestion(d);
};

/** At most this many photos on one question: they are stored inside it until blob uploads are switched on. */
export const MAX_QUESTION_PHOTOS = 20;

/** Adds photos to the question (only the new ones are sent, so each request stays small). */
export const addPhotos = async (number: number, files: unknown[], caller: ProjectCaller) => {
    teamOnly(caller, 'add photos to a question');
    const d = await loadQuestion(number, caller);
    if ((d.photos ?? []).length + files.length > MAX_QUESTION_PHOTOS) {
        throw AppError.unprocessable(`A question can have at most ${MAX_QUESTION_PHOTOS} photos.`, ERROR_CODES.VALIDATION_ERROR);
    }
    d.photos = [...(d.photos ?? []), ...files];
    await d.save();
    return toPublicQuestion(d);
};

export const addMessage = async (number: number, body: { text: string; files: unknown[] }, caller: ProjectCaller) => {
    const d = await loadQuestion(number, caller);
    d.messages.push({
        who: await nameOf(caller.id),
        by_id: caller.id,
        side: isClientCaller(caller) ? 'client' : 'team',
        text: body.text,
        files: body.files,
        when: new Date(),
    });
    await d.save();
    return toPublicQuestion(d);
};

export const editMessage = async (number: number, index: number, text: string, caller: ProjectCaller) => {
    const d = await loadQuestion(number, caller);
    const msg = d.messages[index];
    if (!msg) throw AppError.notFound('That message does not exist.');
    if (!caller.id.equals(msg.by_id)) throw AppError.forbidden('You can only edit your own messages.');
    msg.text = text;
    d.markModified('messages');
    await d.save();
    return toPublicQuestion(d);
};

// ─── DevOps requests ────────────────────────────────────────────────────

const toPublicRequest = (d: DevopsRequestDocument) => ({
    number: d.number,
    devops_key: d.devops_key,
    project_id: d.project_id ? String(d.project_id) : null,
    pname: d.pname,
    rkey: d.rkey,
    type: d.type,
    prio: d.prio,
    to: d.to,
    text: d.text,
    desc: d.desc ?? '',
    due: d.due ?? '',
    start: d.start ?? '',
    est: d.est ?? '',
    by: d.by,
    raised: d.raised,
    status: d.status,
    comments: (d.comments ?? []).map(({ by, text, when, side }) => ({ by, text, when, side })),
    history: d.history ?? [],
    logs: d.logs ?? [],
    seen_t: d.seen_t ?? 0,
    status_seen: d.status_seen ?? 'Open',
    created_at: d.created_at,
});

const loadRequest = async (number: number) => {
    const d = await DevopsRequest.findOne({ number });
    if (!d) throw AppError.notFound('That request does not exist.');
    return d;
};

export const listRequests = async (caller: ProjectCaller) => {
    const ids = await visibleProjectIds(caller);
    const rows = await DevopsRequest.find(ids ? { project_id: { $in: ids } } : {})
        .sort({ number: -1 })
        .lean<DevopsRequestDocument[]>();
    return rows.map(toPublicRequest);
};

export const createRequest = async (body: Data & { number: number; devops_key: string; text: string }, caller: ProjectCaller) => {
    teamOnly(caller, 'raise DevOps requests');
    if (await DevopsRequest.findOne({ number: body.number }).select('_id').lean()) throw taken();
    const doc = await createOrConflict(async () =>
        DevopsRequest.create({
            ...body,
            project_id: await projectOfKey(body.devops_key),
            by: await nameOf(caller.id),
            by_id: caller.id,
            status: 'Open',
            comments: [],
            history: [],
        })
    );
    await audit(caller, AUDIT_ACTIONS.DEVOPS_REQUEST_CREATE, AUDIT_TARGET_KINDS.DEVOPS_REQUEST, doc._id, { number: body.number });
    return toPublicRequest(doc);
};

export const updateRequest = async (number: number, body: { patch: Data; log?: { text: string } }, caller: ProjectCaller) => {
    teamOnly(caller, 'change DevOps requests');
    const d = await loadRequest(number);
    Object.assign(d, body.patch);
    if (body.log) d.history.unshift({ by: await nameOf(caller.id), text: body.log.text, when: new Date() });
    await d.save();
    await audit(caller, AUDIT_ACTIONS.DEVOPS_REQUEST_UPDATE, AUDIT_TARGET_KINDS.DEVOPS_REQUEST, d._id, { number, fields: Object.keys(body.patch) });
    return toPublicRequest(d);
};

export const addRequestComment = async (number: number, body: { text: string; side: 'tickets' | 'devops' }, caller: ProjectCaller) => {
    teamOnly(caller, 'reply on DevOps requests');
    const d = await loadRequest(number);
    d.comments.push({ by: await nameOf(caller.id), by_id: caller.id, text: body.text, when: new Date(), side: body.side });
    await d.save();
    return toPublicRequest(d);
};
