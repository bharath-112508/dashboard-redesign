import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const inter = readFileSync(req.resolve('@fontsource/inter/files/inter-latin-400-normal.woff'));
const interB = readFileSync(req.resolve('@fontsource/inter/files/inter-latin-700-normal.woff'));

vi.mock('./slack-home-fonts.js', () => ({
    loadHomeFonts: () => [
        { name: 'Inter', data: inter, weight: 400, style: 'normal' },
        { name: 'Inter', data: interB, weight: 700, style: 'normal' },
        { name: 'Playfair', data: interB, weight: 700, style: 'normal' },
        { name: 'Playfair', data: interB, weight: 700, style: 'italic' },
    ],
}));
vi.mock('./attendance.service.js', () => ({
    getAttendanceTrend: vi.fn(async () =>
        Array.from({ length: 12 }, (_, i) => ({
            date: `2026-06-${String(i + 1).padStart(2, '0')}`,
            present: (i % 9) + 1,
        }))
    ),
}));
vi.mock('../utils/azure-blob.js', () => ({
    isAzureConfigured: vi.fn(() => true),
    putBlob: vi.fn(async () => undefined),
    mintDownloadSas: vi.fn(() => ({ url: 'https://blob/slack-home/x.png?sig=abc' })),
}));

import { renderHomeDashboardPng, getOrRenderHomeImageUrl, __resetHomeImageCache } from './slack-home-image.service.js';
import { isAzureConfigured, putBlob, mintDownloadSas } from '../utils/azure-blob.js';

const emp = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj Mehta' } as never;
const reviewer = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Big Boss' } as never;
const data = (over: Record<string, unknown>) =>
    ({
        user: emp,
        my_today: null,
        my_balances: [],
        my_pending: [],
        whos_out: [],
        team_attendance: null,
        pending_leaves: null,
        pending_total: null,
        ...over,
    }) as never;
const isPng = (b: Buffer) => Buffer.isBuffer(b) && b.subarray(0, 4).toString('hex') === '89504e47' && b.length > 1000;

describe('renderHomeDashboardPng', () => {
    it('renders a PNG for an employee (no team/pending data)', async () => {
        const png = await renderHomeDashboardPng(
            data({
                user: emp,
                my_balances: [
                    { leave_type: { code: 'CL' }, available: 6 },
                    { leave_type: { code: 'SL' }, available: 4 },
                ],
            }),
            emp
        );
        expect(isPng(png)).toBe(true);
    });
    it('renders a PNG for a reviewer with team summary + pending list', async () => {
        const png = await renderHomeDashboardPng(
            data({
                user: reviewer,
                team_attendance: {
                    headcount: 11,
                    present: 2,
                    incomplete: 0,
                    on_leave: 0,
                    not_in_count: 9,
                    not_in_roster: [],
                },
                pending_total: 2,
                pending_leaves: [
                    {
                        id: 'L1',
                        start_date: '2026-07-01',
                        end_date: '2026-07-03',
                        total_days: 3,
                        requested_leave_type: { code: 'CL' },
                        user: { full_name: 'Sneha Patil' },
                    },
                    {
                        id: 'L2',
                        start_date: '2026-06-15',
                        end_date: '2026-06-15',
                        total_days: 1,
                        requested_leave_type: { code: 'SL' },
                        user: { full_name: 'Vikram Nair' },
                    },
                ],
            }),
            reviewer
        );
        expect(isPng(png)).toBe(true);
    });
});

describe('getOrRenderHomeImageUrl', () => {
    beforeEach(() => {
        __resetHomeImageCache();
        (isAzureConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
        (mintDownloadSas as ReturnType<typeof vi.fn>).mockReturnValue({
            url: 'https://blob/slack-home/x.png?sig=abc',
        });
    });
    it('returns null when Azure is not configured', async () => {
        (isAzureConfigured as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
        expect(await getOrRenderHomeImageUrl(emp, data({}))).toBeNull();
    });
    it('renders, uploads, returns a SAS url, and caches within TTL', async () => {
        const url1 = await getOrRenderHomeImageUrl(emp, data({}));
        expect(url1).toMatch(/^https:\/\/blob\//);
        const calls = (putBlob as ReturnType<typeof vi.fn>).mock.calls.length;
        const url2 = await getOrRenderHomeImageUrl(emp, data({}));
        expect(url2).toBe(url1);
        expect((putBlob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls); // cached, no re-upload
    });
    it('force bypasses the cache (re-uploads)', async () => {
        await getOrRenderHomeImageUrl(emp, data({}));
        const calls = (putBlob as ReturnType<typeof vi.fn>).mock.calls.length;
        await getOrRenderHomeImageUrl(emp, data({}), { force: true });
        expect((putBlob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
    });
});
