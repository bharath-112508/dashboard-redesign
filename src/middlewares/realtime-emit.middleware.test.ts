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
    it('does not publish for GET', () => {
        run('GET', '/leaves', 200);
        expect(publishMock).not.toHaveBeenCalled();
    });
    it('does not publish for non-2xx', () => {
        run('POST', '/leaves', 400);
        expect(publishMock).not.toHaveBeenCalled();
    });
    it('does not publish for an unmapped path', () => {
        run('POST', '/something-else', 200);
        expect(publishMock).not.toHaveBeenCalled();
    });
});
