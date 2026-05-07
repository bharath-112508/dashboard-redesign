import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/holiday.service.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { created, noContent, ok } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import type {
    BulkCreateHolidaysBody,
    CreateHolidayBody,
    ListHolidaysQuery,
    PatchHolidayBody,
} from '../validators/holiday.validator.js';

const callerId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

const parseTargetId = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

// ─── POST /holidays ────────────────────────────────────────────────────────

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    // I1 — thread audit context so admin holiday-calendar mutations are traceable.
    const data = await service.createHoliday(req.body as CreateHolidayBody, callerId(req), buildAuditContext(req));
    return created(res, data);
};

// ─── POST /holidays/bulk ──────────────────────────────────────────────────

export const postBulk = async (req: Request, res: Response): Promise<Response> => {
    const result = await service.bulkCreateHolidays(
        req.body as BulkCreateHolidaysBody,
        callerId(req),
        buildAuditContext(req)
    );
    // 201 even when some rows skipped — the new rows were created. The
    // payload tells the caller exactly which ones got in and which didn't.
    return created(res, result);
};

// ─── GET /holidays ─────────────────────────────────────────────────────────
//
// Non-paginated list with sidecar metadata `{ total, from_date?, to_date? }` —
// echoes back the resolved query window so the FE doesn't have to recompute
// it. NOT a paginated response (no `page`/`limit`/`total_pages`), so we use
// `ok(res, data, meta)` rather than `paginated()`. The api.ts FE envelope-
// preserve rule keeps the envelope intact for any `meta` sibling, so consumers
// type the hook as `EnvelopedList<HolidayRecord>` and unwrap via TanStack
// `select` (see [holiday-mutations.ts](FE) — that pattern was the M1 fix
// after the `.slice is not a function` crash).
export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listHolidays(req.query as unknown as ListHolidaysQuery);
    return ok(res, data, meta);
};

// ─── PATCH /holidays/:id ──────────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateHoliday(parseTargetId(req), req.body as PatchHolidayBody, buildAuditContext(req));
    return ok(res, data);
};

// ─── DELETE /holidays/:id ─────────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteHoliday(parseTargetId(req), buildAuditContext(req));
    return noContent(res);
};
