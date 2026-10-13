import { describe, expect, it, vi } from 'vitest';

import { created, noContent, ok, paginated } from './api-response.js';

/**
 * Response envelope helpers — every controller in the codebase ships
 * its responses through one of these. The contract worth pinning at
 * this layer is API_Contract §1.4: every successful response is
 * shaped `{ data }` or `{ data, meta }` and uses the right status
 * code (200 / 201 / 204).
 *
 * What we lock in:
 *   1. `ok` defaults to `{ data }` and switches to `{ data, meta }`
 *      when meta is supplied — the FE keys off the presence of
 *      `meta` to render pagination.
 *   2. `created` always uses 201 + `{ data }` (no meta envelope on
 *      a single-resource POST).
 *   3. `noContent` returns 204 with NO body — a regression that
 *      sent a JSON body would break HTTP-204 semantics.
 *   4. `paginated` always emits `{ page, limit, total, total_pages }`
 *      under `meta` so the FE pagination component keys cleanly.
 */

const mockRes = () => {
    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
        send: vi.fn().mockReturnThis(),
    };
    return res;
};

describe('ok()', () => {
    it('returns 200 + `{ data }` with no meta by default', () => {
        const res = mockRes();
        ok(res as never, { id: '1' });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ data: { id: '1' } });
    });

    it('returns 200 + `{ data, meta }` when meta is supplied', () => {
        const res = mockRes();
        ok(res as never, [{ id: '1' }], { total: 1 });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ data: [{ id: '1' }], meta: { total: 1 } });
    });
});

describe('created()', () => {
    it('returns 201 + `{ data }` (never embeds meta)', () => {
        const res = mockRes();
        created(res as never, { id: 'new-resource' });
        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith({ data: { id: 'new-resource' } });
    });
});

describe('noContent()', () => {
    it('returns 204 with no body (uses send() not json())', () => {
        // HTTP-204 explicitly forbids a response body. A regression that
        // started using `.json()` here would emit a body the spec disallows
        // — some intermediaries strip it; some reject the response entirely.
        const res = mockRes();
        noContent(res as never);
        expect(res.status).toHaveBeenCalledWith(204);
        expect(res.send).toHaveBeenCalledWith();
        expect(res.json).not.toHaveBeenCalled();
    });
});

describe('paginated()', () => {
    it('returns 200 + `{ data, meta }` with the canonical pagination keys', () => {
        const res = mockRes();
        const meta = { page: 2, limit: 50, total: 137, total_pages: 3 };
        paginated(res as never, [{ id: '1' }, { id: '2' }], meta);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            data: [{ id: '1' }, { id: '2' }],
            meta,
        });
    });
});
