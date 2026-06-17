import type { Response } from 'express';

import logger from '../utils/logger.js';

/**
 * In-process SSE client registry + fan-out. Single-instance today; if the
 * backend scales out, back this with a pub/sub backplane (Redis / Azure Web
 * PubSub) — the addClient/removeClient/publish interface stays the same.
 *
 * Events are data-less: `publish(['leaves'])` emits a `change` event carrying
 * only topic names. Clients refetch through the authed API.
 */

interface RealtimeClient {
    id: string;
    res: Response;
    userId: string;
}

const clients = new Map<string, RealtimeClient>();
let seq = 0;

export const addClient = (res: Response, userId: string): string => {
    const id = `c${++seq}`;
    clients.set(id, { id, res, userId });
    return id;
};

export const removeClient = (id: string): void => {
    clients.delete(id);
};

export const clientCount = (): number => clients.size;

/**
 * Fan a data-less `change` event out to every connected client. Per-client
 * write failures (dead sockets) drop that client and never throw to the
 * caller — the emit side is always best-effort.
 */
export const publish = (topics: string[]): void => {
    if (clients.size === 0 || topics.length === 0) return;
    const frame = `event: change\ndata: ${JSON.stringify({ topics })}\n\n`;
    for (const client of clients.values()) {
        try {
            client.res.write(frame);
        } catch (err) {
            logger.warn({ err, code: 'SSE_CLIENT_WRITE_FAILED', client_id: client.id }, 'Dropping dead SSE client');
            clients.delete(client.id);
        }
    }
};

/** Test-only — reset the registry between tests. */
export const __resetRealtimeClients = (): void => {
    clients.clear();
    seq = 0;
};
