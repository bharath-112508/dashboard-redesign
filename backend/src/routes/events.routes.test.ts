import { describe, expect, it, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { EventEmitter } from 'node:events';

vi.mock('../middlewares/auth.middleware.js', () => ({
    authenticate: (req: Request, res: Response, next: NextFunction) => {
        if (!req.headers.authorization) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'no' } });
            return;
        }
        (req as unknown as { user: { user_id: string } }).user = { user_id: 'u1' };
        next();
    },
}));

const realtimeMock = vi.hoisted(() => ({
    addClient: vi.fn(() => 'client-1'),
    removeClient: vi.fn(),
}));

vi.mock('../services/realtime.service.js', () => realtimeMock);

import eventsRoutes from './events.routes.js';

const app = express();
app.use('/api/v1', eventsRoutes);

/**
 * Pull the `/events/stream` GET handler out of the router stack so we can drive
 * it with a fake req/res. The supertest variant hangs because SSE keeps the
 * socket open forever, so we test the handler in isolation instead.
 */
const streamHandler = (() => {
    type Layer = {
        route?: {
            path: string;
            stack: { handle: (req: Request, res: Response, next: NextFunction) => void }[];
        };
    };
    const stack = (eventsRoutes as unknown as { stack: Layer[] }).stack;
    const layer = stack.find((l) => l.route?.path === '/events/stream');
    if (!layer?.route) throw new Error('GET /events/stream handler not found in router');
    // [0] is `authenticate`, [1] is the SSE handler.
    return layer.route.stack[layer.route.stack.length - 1].handle;
})();

describe('GET /events/stream', () => {
    it('401s without auth', async () => {
        const res = await request(app).get('/api/v1/events/stream');
        expect(res.status).toBe(401);
    });

    it('opens a text/event-stream and registers the client', () => {
        realtimeMock.addClient.mockClear();
        realtimeMock.removeClient.mockClear();

        const req = new EventEmitter() as unknown as Request & EventEmitter;
        (req as unknown as { headers: Record<string, string> }).headers = { authorization: 'Bearer x' };
        (req as unknown as { user: { user_id: string } }).user = { user_id: 'u1' };

        const setHeader = vi.fn();
        const res = {
            setHeader,
            flushHeaders: vi.fn(),
            write: vi.fn(),
        } as unknown as Response;

        streamHandler(req, res, vi.fn());

        expect(setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
        expect(realtimeMock.addClient).toHaveBeenCalledWith(res, 'u1');

        // Closing the socket tears the heartbeat down and deregisters the client.
        (req as EventEmitter).emit('close');
        expect(realtimeMock.removeClient).toHaveBeenCalledWith('client-1');
    });
});
