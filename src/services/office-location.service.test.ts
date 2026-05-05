import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';

/**
 * Coverage focus for `office-location.service` — admin-only mutations
 * of attendance check-in anchors + their secret QR tokens:
 *
 *   1. `createOfficeLocation` — happy path mints a unique QR token
 *      and persists; on E11000 (qr_code_token collision), retries
 *      up to N times. The I1 audit row's `after` is the SAFE
 *      projection (`toAuditSnapshot`) — NEVER includes the secret
 *      `qr_code_token` or the bulky `qr_data_url` PNG.
 *   2. `updateOfficeLocation` — applies partial fields, audit row
 *      records before/after diff (also via the safe projection).
 *   3. `deactivateOfficeLocation` — returns 404 on unknown id, sets
 *      is_active=false otherwise; audit row records the transition.
 *   4. `regenerateQrToken` — rotates the token (different from the
 *      previous one), nulls out the stale image URL, emits a minimal
 *      audit row that records the rotation EVENT but NEVER echoes the
 *      new token (a token in the audit log would defeat the rotation).
 *   5. The audit hook is OPTIONAL — every entry point still works
 *      without an AuditContext.
 */

const { officeLocationCreateMock, officeLocationFindByIdMock, officeLocationFindByIdAndUpdateMock, recordAuditMock } =
    vi.hoisted(() => ({
        officeLocationCreateMock: vi.fn(),
        officeLocationFindByIdMock: vi.fn(),
        officeLocationFindByIdAndUpdateMock: vi.fn(),
        recordAuditMock: vi.fn(),
    }));

vi.mock('../models/office-location.model.js', () => ({
    OfficeLocation: {
        create: officeLocationCreateMock,
        findById: officeLocationFindByIdMock,
        findByIdAndUpdate: officeLocationFindByIdAndUpdateMock,
        find: vi.fn(),
        countDocuments: vi.fn(),
    },
}));

// QR data URL renderer is irrelevant to audit logic — stub to a constant.
vi.mock('../utils/office-location-qr.js', () => ({
    generateQrToken: vi.fn(() => `tok_${Math.random().toString(36).slice(2, 10)}`),
    renderCheckInQrDataUrl: vi.fn(async () => 'data:image/png;base64,STUB'),
}));

vi.mock('./audit.service.js', () => ({
    recordAudit: recordAuditMock,
    recordSystemAudit: vi.fn(),
}));

const svc = await import('./office-location.service.js');
import { ERROR_CODES } from '../constants/error-codes.js';

const makeAudit = () => ({ actor_id: new Types.ObjectId(), actor_role: 'admin' as const });

const makeOfficeLocation = (overrides: Record<string, unknown> = {}) => {
    const doc = {
        _id: new Types.ObjectId(),
        name: 'HQ',
        address: '1 Marina Bay',
        qr_code_token: 'SECRET-TOKEN-DO-NOT-LEAK',
        qr_code_image_url: null as string | null,
        is_active: true,
        save: vi.fn(),
        toJSON() {
            return {
                id: this._id.toString(),
                name: this.name,
                address: this.address,
                qr_code_token: this.qr_code_token,
                qr_code_image_url: this.qr_code_image_url,
                is_active: this.is_active,
            };
        },
        ...overrides,
    };
    doc.save.mockImplementation(async () => doc);
    return doc;
};

beforeEach(() => {
    vi.resetAllMocks();
});

// ─── createOfficeLocation ─────────────────────────────────────────────────

describe('createOfficeLocation', () => {
    it('persists with a freshly-minted QR token and returns the public projection', async () => {
        const doc = makeOfficeLocation();
        officeLocationCreateMock.mockResolvedValueOnce(doc);

        const result = await svc.createOfficeLocation({ name: 'HQ', address: '1 Marina Bay' }, new Types.ObjectId());

        expect(result).toMatchObject({ name: 'HQ', address: '1 Marina Bay' });
        expect(officeLocationCreateMock).toHaveBeenCalledTimes(1);
    });

    it('retries on qr_code_token E11000 collision (vanishingly rare but pinned)', async () => {
        // First attempt collides on the unique-token index → retry → second
        // attempt succeeds. The retry budget is `QR_TOKEN_REGENERATION_RETRY_LIMIT`
        // (3 today); pin one collision so the retry path is actually exercised.
        const doc = makeOfficeLocation();
        officeLocationCreateMock
            .mockRejectedValueOnce({ code: 11000, keyPattern: { qr_code_token: 1 } })
            .mockResolvedValueOnce(doc);

        const result = await svc.createOfficeLocation({ name: 'HQ', address: '1 Marina Bay' }, new Types.ObjectId());

        expect(officeLocationCreateMock).toHaveBeenCalledTimes(2);
        expect(result).toMatchObject({ name: 'HQ' });
    });

    it('I1 — audit row deliberately STRIPS the qr_code_token + qr_data_url from `after`', async () => {
        // The cardinal rule: the audit log must never contain the
        // check-in secret. A regression that landed `qr_code_token` in
        // the audit row would let anyone with audit-read access defeat
        // geofence enforcement.
        const doc = makeOfficeLocation({ qr_code_token: 'SECRET-DO-NOT-LEAK' });
        officeLocationCreateMock.mockResolvedValueOnce(doc);

        await svc.createOfficeLocation({ name: 'HQ', address: '1 Marina Bay' }, new Types.ObjectId(), makeAudit());

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'office_location.create',
            target: { kind: 'office_location', id: doc._id },
            after: expect.objectContaining({ name: 'HQ', address: '1 Marina Bay', is_active: true }),
        });
        // The secret MUST NOT appear ANYWHERE in the audit payload.
        const serialised = JSON.stringify(payload);
        expect(serialised).not.toContain('SECRET-DO-NOT-LEAK');
        // And no `qr_data_url` (would blow the per-snapshot byte cap).
        expect(serialised).not.toContain('qr_data_url');
    });
});

// ─── updateOfficeLocation ─────────────────────────────────────────────────

describe('updateOfficeLocation', () => {
    it('returns 404 when the id is unknown', async () => {
        officeLocationFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.updateOfficeLocation(new Types.ObjectId(), { name: 'X' })).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
            statusCode: 404,
        });
    });

    it('applies fields and saves', async () => {
        const doc = makeOfficeLocation({ name: 'Old', address: 'A' });
        officeLocationFindByIdMock.mockResolvedValueOnce(doc);

        await svc.updateOfficeLocation(doc._id, { name: 'New', address: 'B' });

        expect(doc.name).toBe('New');
        expect(doc.address).toBe('B');
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('I1 — audit row records before/after diff WITHOUT the qr_code_token', async () => {
        const doc = makeOfficeLocation({
            name: 'Old',
            qr_code_token: 'NEVER-IN-AUDIT-LOG',
        });
        officeLocationFindByIdMock.mockResolvedValueOnce(doc);

        await svc.updateOfficeLocation(doc._id, { name: 'New' }, makeAudit());

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'office_location.update',
            target: { kind: 'office_location', id: doc._id },
            before: expect.objectContaining({ name: 'Old' }),
            after: expect.objectContaining({ name: 'New' }),
        });
        expect(JSON.stringify(payload)).not.toContain('NEVER-IN-AUDIT-LOG');
    });
});

// ─── deactivateOfficeLocation ─────────────────────────────────────────────

describe('deactivateOfficeLocation', () => {
    it('returns 404 when the id is unknown', async () => {
        officeLocationFindByIdAndUpdateMock.mockResolvedValueOnce(null);
        await expect(svc.deactivateOfficeLocation(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('flips is_active=false via findByIdAndUpdate; audit row pins the transition', async () => {
        const doc = makeOfficeLocation({ is_active: false });
        officeLocationFindByIdAndUpdateMock.mockResolvedValueOnce(doc);

        await svc.deactivateOfficeLocation(doc._id, makeAudit());

        expect(officeLocationFindByIdAndUpdateMock).toHaveBeenCalledWith(
            doc._id,
            { $set: { is_active: false } },
            { new: true }
        );
        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'office_location.deactivate',
            target: { kind: 'office_location', id: doc._id },
            before: { is_active: true },
            after: { is_active: false },
        });
    });
});

// ─── regenerateQrToken ────────────────────────────────────────────────────

describe('regenerateQrToken', () => {
    it('rotates the token to a new value and nulls the stale image URL', async () => {
        const doc = makeOfficeLocation({
            qr_code_token: 'OLD-TOKEN',
            qr_code_image_url: 'https://stale-blob/qr.png',
        });
        officeLocationFindByIdMock.mockResolvedValueOnce(doc);

        await svc.regenerateQrToken(doc._id);

        expect(doc.qr_code_token).not.toBe('OLD-TOKEN');
        // The pre-rotation Blob image points at the old token; null it
        // out so a downstream reader doesn't accidentally serve the
        // stale QR until the next render.
        expect(doc.qr_code_image_url).toBeNull();
        expect(doc.save).toHaveBeenCalledTimes(1);
    });

    it('returns 404 when the id is unknown', async () => {
        officeLocationFindByIdMock.mockResolvedValueOnce(null);
        await expect(svc.regenerateQrToken(new Types.ObjectId())).rejects.toMatchObject({
            code: ERROR_CODES.RESOURCE_NOT_FOUND,
        });
    });

    it('I1 — audit row records the rotation EVENT but NEVER echoes the new token', async () => {
        // Cardinal rule for the rotation path: the new token's whole job
        // is to invalidate the old one. Logging the new value would
        // defeat that — anyone with audit-read could keep checking in
        // with the rotated value.
        const doc = makeOfficeLocation({ qr_code_token: 'OLD' });
        officeLocationFindByIdMock.mockResolvedValueOnce(doc);

        await svc.regenerateQrToken(doc._id, makeAudit());

        const [, payload] = recordAuditMock.mock.calls[0]!;
        expect(payload).toMatchObject({
            action: 'office_location.qr_rotate',
            target: { kind: 'office_location', id: doc._id },
        });
        // Defence in depth — pin that the rotation row has NO before /
        // no after / no metadata.qr_code_token. Anything that smells
        // like a token field MUST NOT be present.
        const serialised = JSON.stringify(payload);
        expect(serialised).not.toContain(doc.qr_code_token);
        expect(serialised).not.toContain('qr_code_token');
    });
});
