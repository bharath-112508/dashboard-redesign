import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as service from '../services/company.service.js';
import { created, ok, paginated } from '../utils/api-response.js';
import { projectCallerFrom } from '../utils/caller.js';
import type {
    CreateCompanyBody,
    CreateRepresentativeBody,
    ListCompaniesQuery,
    ListRepresentativesQuery,
    PatchCompanyBody,
} from '../validators/company.validator.js';

/**
 * Companies controller — thin. Auth + permission gating at the route layer;
 * per-company ownership scoping (a `client` may only touch their own) is
 * enforced in the service, because RBAC can express the verb but not the
 * scope.
 */

const idOf = (req: Request): Types.ObjectId => new Types.ObjectId(req.params.id as string);

export const postCreate = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createCompany(req.body as CreateCompanyBody, projectCallerFrom(req));
    return created(res, data);
};

export const getList = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listCompanies(
        req.query as unknown as ListCompaniesQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

export const getById = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getCompany(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const patchById = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.patchCompany(idOf(req), req.body as PatchCompanyBody, projectCallerFrom(req));
    return ok(res, data);
};

export const postArchive = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.archiveCompany(idOf(req), projectCallerFrom(req));
    return ok(res, data);
};

export const getRepresentatives = async (req: Request, res: Response): Promise<Response> => {
    const { data, meta } = await service.listRepresentatives(
        idOf(req),
        req.query as unknown as ListRepresentativesQuery,
        projectCallerFrom(req)
    );
    return paginated(res, data, meta);
};

export const getRepresentative = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.getRepresentative(
        idOf(req),
        new Types.ObjectId(req.params.user_id as string),
        projectCallerFrom(req)
    );
    return ok(res, data);
};

export const deleteRepresentative = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.removeRepresentative(
        idOf(req),
        new Types.ObjectId(req.params.user_id as string),
        projectCallerFrom(req)
    );
    return ok(res, data);
};

export const postRepresentative = async (req: Request, res: Response): Promise<Response> => {
    const data = await service.createRepresentative(
        idOf(req),
        req.body as CreateRepresentativeBody,
        projectCallerFrom(req)
    );
    return created(res, data);
};
