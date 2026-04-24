import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/jwt.js';
import { AppError } from '../utils/app-error.js';
import { RoleType } from '../constants/index.js';
import { BaseJWTPayload } from '../types/index.js';

declare global {
    namespace Express {
        interface Request {
            user?: BaseJWTPayload;
        }
    }
}

export const authenticate = (req: Request, _res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw AppError.unauthenticated();
    }

    const token = authHeader.split(' ')[1];
    const payload = verifyAccessToken(token) as BaseJWTPayload & { type?: string };

    // Defence in depth: refresh or mfa_session tokens must never be accepted here,
    // even though the secrets differ / session type carries its own claim.
    if (payload.type) {
        throw AppError.unauthenticated();
    }

    req.user = payload;
    next();
};

export const authorize = (...allowedRoles: RoleType[]) => {
    return (req: Request, _res: Response, next: NextFunction): void => {
        if (!req.user) {
            throw AppError.unauthenticated();
        }

        if (!allowedRoles.includes(req.user.role)) {
            throw AppError.forbidden();
        }

        next();
    };
};
