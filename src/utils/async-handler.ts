import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps async route handlers to automatically catch errors and pass them to the error handler
 * This eliminates the need for try-catch blocks in every controller
 */
export const asyncHandler = (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<Response | void>
): RequestHandler => {
    return (req: Request, res: Response, next: NextFunction) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};
