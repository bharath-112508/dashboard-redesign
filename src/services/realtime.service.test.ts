import { describe, expect, it, vi, beforeEach } from 'vitest';
import { addClient, removeClient, publish, clientCount, __resetRealtimeClients } from './realtime.service.js';

const fakeRes = () => ({ write: vi.fn(() => true) }) as unknown as import('express').Response;

beforeEach(() => __resetRealtimeClients());

describe('realtime.service', () => {
    it('registers and counts clients, removes them', () => {
        const id = addClient(fakeRes(), 'u1');
        expect(clientCount()).toBe(1);
        removeClient(id);
        expect(clientCount()).toBe(0);
    });

    it('publish writes a `change` event with topics to every client', () => {
        const a = fakeRes();
        const b = fakeRes();
        addClient(a, 'u1');
        addClient(b, 'u2');
        publish(['leaves']);
        const expected = `event: change\ndata: ${JSON.stringify({ topics: ['leaves'] })}\n\n`;
        expect(a.write).toHaveBeenCalledWith(expected);
        expect(b.write).toHaveBeenCalledWith(expected);
    });

    it('drops a client whose write throws, others still receive', () => {
        const bad = {
            write: vi.fn(() => {
                throw new Error('EPIPE');
            }),
        } as unknown as import('express').Response;
        const good = fakeRes();
        addClient(bad, 'u1');
        addClient(good, 'u2');
        publish(['attendance']);
        expect(good.write).toHaveBeenCalled();
        expect(clientCount()).toBe(1);
    });

    it('publish with no clients or empty topics is a no-op', () => {
        expect(() => publish([])).not.toThrow();
    });
});
