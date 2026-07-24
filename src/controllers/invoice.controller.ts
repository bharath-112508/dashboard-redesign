import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/invoice.service.js';
import { created, noContent, ok, paginated } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    GenerateInvoiceInput,
    InvoiceStatusInput,
    ListInvoicesQuery,
    UpdateInvoiceInput,
} from '../validators/invoice.validator.js';

/**
 * Invoice controller — Phase 1 "Client Engagements & Invoicing", Task 8.
 * Mirrors `engagement.controller.ts` / `billing-rate.controller.ts`: thin
 * HTTP shaping only, all business logic lives in `invoice.service.ts`.
 */

const callerOf = (req: Request): service.InvoiceActor => {
    if (!req.user?.user_id) throw AppError.unauthenticated();
    return {
        id: new Types.ObjectId(req.user.user_id),
        audit: buildAuditContext(req),
    };
};

const idOf = (req: Request, key: string): Types.ObjectId => new Types.ObjectId(req.params[key] as string);

// ─── GET /invoices ────────────────────────────────────────────────────────

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listInvoices(req.query as unknown as ListInvoicesQuery);
    return paginated(res, data, meta);
};

// ─── POST /invoices/generate ─────────────────────────────────────────────

export const postGenerate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.generateInvoice(req.body as GenerateInvoiceInput, callerOf(req));
    return created(res, data);
};

// ─── GET /invoices/:id ────────────────────────────────────────────────────

export const getOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getInvoice(idOf(req, 'id'));
    return ok(res, data);
};

// ─── PATCH /invoices/:id ──────────────────────────────────────────────────

export const patchOne = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.updateInvoice(idOf(req, 'id'), req.body as UpdateInvoiceInput, callerOf(req));
    return ok(res, data);
};

// ─── POST /invoices/:id/status ────────────────────────────────────────────

export const postStatus = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as InvoiceStatusInput;
    const data = await service.setInvoiceStatus(idOf(req, 'id'), body.to, { paid_date: body.paid_date }, callerOf(req));
    return ok(res, data);
};

// ─── DELETE /invoices/:id ──────────────────────────────────────────────────

export const deleteOne = async (req: Request, res: Response): Promise<Response> => {
    await service.deleteInvoice(idOf(req, 'id'), callerOf(req));
    return noContent(res);
};
