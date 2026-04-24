import { Response } from 'express';
import { StatusCodes } from 'http-status-codes';

/**
 * Response envelope helpers per API_Contract §1.4.
 *
 *   ok(res, data)         → 200 { data }
 *   ok(res, data, meta)   → 200 { data, meta }
 *   created(res, data)    → 201 { data }
 *   noContent(res)        → 204 (empty body)
 *   paginated(res, ...)   → 200 { data, meta: { page, limit, total, total_pages } }
 */

export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
}

export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>): Response => {
    return res.status(StatusCodes.OK).json(meta ? { data, meta } : { data });
};

export const created = <T>(res: Response, data: T): Response => {
    return res.status(StatusCodes.CREATED).json({ data });
};

export const noContent = (res: Response): Response => {
    return res.status(StatusCodes.NO_CONTENT).send();
};

export const paginated = <T>(res: Response, data: T[], meta: PaginationMeta): Response => {
    return res.status(StatusCodes.OK).json({ data, meta });
};
