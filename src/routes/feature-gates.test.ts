// src/routes/feature-gates.test.ts
//
// Surfaces that are built but out of scope for the current phase must be
// UNREACHABLE, not merely unlinked in the UI. The frontend hid the billing
// module from 2026-07-31 while the API stayed open, which left the data one
// authenticated request away from anyone holding the permission — that is the
// failure mode these gates exist to prevent, so it is the one pinned here.
//
// This file is the inverse of `invoice.routes.test.ts` / `report.routes.test.ts`:
// those two opt the gate ON to exercise the module's real behaviour, this one
// leaves it at its default (OFF) and asserts every surface 404s.
//
// The assertions deliberately use a token that WOULD pass the permission
// checks — an admin. A 404 for a caller who lacks permission proves nothing;
// a 404 for one who has it proves the gate is what closed the door.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import request from 'supertest';

const { userFindByIdMock, settingsMock } = vi.hoisted(() => ({
    userFindByIdMock: vi.fn(),
    settingsMock: vi.fn(),
}));

vi.mock('../models/user.model.js', () => ({
    User: { findById: userFindByIdMock },
}));

vi.mock('../services/settings.service.js', () => ({
    getOrInitSettings: settingsMock,
    resolveLoginLockoutPolicy: vi.fn().mockResolvedValue({
        failed_login_threshold: null,
        lockout_duration_minutes: null,
    }),
}));

const { buildTestApp } = await import('../integration/_helpers/build-app.js');
const app = buildTestApp();

const TEST_SECRET = process.env.JWT_SECRET ?? 'test-secret';

/** An admin — the `system.admin` wildcard satisfies every permission gate,
 *  so anything that still 404s is closed by the feature gate alone. */
const adminToken = (): string =>
    jwt.sign(
        {
            user_id: new Types.ObjectId().toString(),
            role: 'admin',
            role_keys: ['admin'],
            permissions: ['system.admin'],
        },
        TEST_SECRET,
        { expiresIn: '1h' }
    );

beforeEach(() => {
    vi.resetAllMocks();
    userFindByIdMock.mockReturnValue({
        select: () => ({ lean: () => Promise.resolve({ status: 'active', mfa_enabled: false }) }),
    });
    settingsMock.mockResolvedValue({
        security: { mfa_required_for_admins: false },
        timesheet: { self_edit_window_days: 7, daily_warn_threshold_hours: 8 },
    });
});

describe('billing modules gate (BILLING_MODULES_ENABLED unset → off)', () => {
    const auth = () => ({ Authorization: `Bearer ${adminToken()}` });

    it.each([
        ['/api/v1/billing-rates'],
        ['/api/v1/cost-rates'],
        ['/api/v1/engagements'],
        ['/api/v1/invoices'],
        ['/api/v1/reports/billing'],
        ['/api/v1/reports/margin'],
    ])('404s GET %s for an admin', async (path) => {
        const res = await request(app).get(path).set(auth());
        expect(res.status).toBe(404);
    });

    it('404s a billing EXPORT — the file must not be a way around the gated GET', async () => {
        const res = await request(app)
            .post('/api/v1/reports/billing/export')
            .set(auth())
            .send({ format: 'csv', from_date: '2026-01-01', to_date: '2026-01-31' });
        expect(res.status).toBe(404);
    });

    it('leaves the non-money reports reachable — the gate is scoped, not a blanket', async () => {
        // Proves the gate didn't take out the reports module wholesale. 404
        // here would mean the guard was mounted too broadly; anything else
        // (200, 400 on a missing filter) means the route still exists.
        const res = await request(app).get('/api/v1/reports/leaves').set(auth());
        expect(res.status).not.toBe(404);
    });
});

describe('office locations gate (OFFICE_LOCATIONS_ENABLED unset → off)', () => {
    const auth = () => ({ Authorization: `Bearer ${adminToken()}` });

    // Single office: its coordinates and geofence radius live on
    // SystemSettings.attendance.geofence, edited under Settings → Work
    // schedule. A directory of one entry earns no screen.
    it.each([['get'], ['post']] as const)('404s %s /api/v1/office-locations for an admin', async (verb) => {
        const res =
            verb === 'get'
                ? await request(app).get('/api/v1/office-locations').set(auth())
                : await request(app).post('/api/v1/office-locations').set(auth()).send({ name: 'X' });
        expect(res.status).toBe(404);
    });

    it('leaves attendance alone — the gate is the directory, not check-in', async () => {
        // Geofence policy is read from the settings document and QR check-in
        // resolves its token straight off the model, so neither goes through
        // the gated router. 404 here would mean the guard was mounted too
        // broadly and had taken working check-in down with the directory.
        //
        // Deliberately sends a bad date so the query validator rejects it
        // BEFORE the service reaches Mongo — this asserts the route is still
        // mounted, without needing the whole attendance service stubbed.
        const res = await request(app).get('/api/v1/attendance/me?from_date=nonsense').set(auth());
        expect(res.status).toBe(400);
    });
});
