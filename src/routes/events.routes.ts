import { Router, type Request, type Response } from 'express';

import { authenticate } from '../middlewares/auth.middleware.js';
import { addClient, removeClient } from '../services/realtime.service.js';
import { SSE_HEARTBEAT_MS } from '../constants/realtime.js';
import logger from '../utils/logger.js';

/**
 * SSE stream for real-time data-change events. Authenticated (JWT bearer).
 * Mounted in `index.ts` BEFORE `compression` so the long-lived stream isn't
 * buffered. Emits a heartbeat comment every SSE_HEARTBEAT_MS to survive idle
 * timeouts; the client (fetch-event-source) auto-reconnects if dropped.
 */
const router = Router();

router.get('/events/stream', authenticate, (req: Request, res: Response) => {
    const userId = String((req as unknown as { user?: { user_id?: unknown } }).user?.user_id ?? 'unknown');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const clientId = addClient(res, userId);
    logger.info({ code: 'SSE_CLIENT_CONNECTED', user_id: userId }, 'SSE client connected');

    const heartbeat = setInterval(() => {
        try {
            res.write(': ping\n\n');
        } catch {
            // write failure means the socket is gone; cleanup runs on 'close'
        }
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
        clearInterval(heartbeat);
        removeClient(clientId);
        logger.info({ code: 'SSE_CLIENT_DISCONNECTED', user_id: userId }, 'SSE client disconnected');
    });
});

export default router;
