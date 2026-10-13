import { describe, expect, it, vi } from 'vitest';

const { info, warn } = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../logger.js', () => ({ default: { info, warn } }));
vi.mock('../../config/server.config.js', () => ({ NODE_ENV: 'staging' }));

const { stubTransport } = await import('./stub.js');

describe('stubTransport outside development', () => {
    it('never logs the email body (it can hold a live password link)', async () => {
        await stubTransport({ to: 'nina@x.io', subject: 'Set your password', text: 'link: https://app/reset-password?token=SECRET', html: '' } as never);
        const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
        expect(logged).not.toContain('SECRET');
        expect(logged).not.toContain('nina@x.io');
    });
});
