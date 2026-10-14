import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const publishMock = vi.fn();
vi.mock('../services/realtime.service.js', () => ({ publish: (t: string[]) => publishMock(t) }));

import { realtimeEmit } from './realtime-emit.middleware.js';

const run = (method: string, path: string, statusCode: number) => {
    const handlers: Record<string, () => void> = {};
    const req = { method, baseUrl: '/api/v1', path } as unknown as Request;
    const res = {
        statusCode,
        on: (ev: string, cb: () => void) => {
            handlers[ev] = cb;
            return res;
        },
    } as unknown as Response;
    const next = vi.fn();
    realtimeEmit(req, res, next);
    expect(next).toHaveBeenCalled();
    handlers.finish?.();
};

beforeEach(() => publishMock.mockReset());

describe('realtimeEmit', () => {
    it('publishes the topic for a 2xx POST to a mapped path', () => {
        run('POST', '/leaves', 201);
        expect(publishMock).toHaveBeenCalledWith(['leaves']);
    });
    it('maps nested paths by first segment (e.g. /attendance/check-in)', () => {
        run('POST', '/attendance/check-in', 200);
        expect(publishMock).toHaveBeenCalledWith(['attendance']);
    });
    it('company changes publish companies (redesign)', () => {
        run('PATCH', '/companies/abc123', 200);
        expect(publishMock).toHaveBeenCalledWith(['companies']);
    });
    it('the permission grid publishes roles (redesign)', () => {
        run('PUT', '/app-access', 200);
        expect(publishMock).toHaveBeenCalledWith(['roles']);
    });
    it('the DevOps board, questions and requests publish their own topics (redesign)', () => {
        run('PATCH', '/devops/items/OPS-1', 200);
        run('POST', '/questions/3/messages', 201);
        run('POST', '/devops-requests', 201);
        run('POST', '/devops-requests/4/comments', 201);
        expect(publishMock.mock.calls).toEqual([[['devops']], [['questions']], [['devops-requests']], [['devops-requests']]]);
    });
    it('InvoiceMatch decisions publish invoicematch (redesign)', () => {
        run('PUT', '/invoicematch/abc/decisions/INV-1', 200);
        expect(publishMock).toHaveBeenCalledWith(['invoicematch']);
    });
    it('does not publish for GET', () => {
        run('GET', '/leaves', 200);
        expect(publishMock).not.toHaveBeenCalled();
    });
    it('does not publish for non-2xx', () => {
        run('POST', '/leaves', 400);
        expect(publishMock).not.toHaveBeenCalled();
    });
    it('a new comment (POST /tasks/:id/comments) also publishes task-comments', () => {
        run('POST', '/tasks/abc123/comments', 201);
        expect(publishMock).toHaveBeenCalledWith(['tasks', 'task-comments']);
    });
    it('a plain task write publishes tasks only', () => {
        run('PATCH', '/tasks/abc123', 200);
        expect(publishMock).toHaveBeenCalledWith(['tasks']);
    });
    it('does not publish for an unmapped path', () => {
        run('POST', '/something-else', 200);
        expect(publishMock).not.toHaveBeenCalled();
    });
});
