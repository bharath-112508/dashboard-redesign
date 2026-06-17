import { Resvg } from '@resvg/resvg-js';
import type { Types } from 'mongoose';
import satori from 'satori';

import { ulid } from 'ulid';

import { getAttendanceTrend } from './attendance.service.js';
import { loadHomeFonts } from './slack-home-fonts.js';
import type { HomeDashboardData } from './slack-home.service.js';
import { AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER } from '../config/server.config.js';
import { isAzureConfigured, putBlob, mintDownloadSas } from '../utils/azure-blob.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';

/**
 * Renders the role-scoped Slack Home dashboard data into a branded PNG using
 * Satori (element tree → SVG) + resvg (SVG → PNG). No Chromium.
 *
 * The layout is the approved "dark editorial" design from the
 * `scripts/slack-dashboard-gallery.ts` spike (`finalCombined()`): a serif/
 * electric-blue hero, KPI cards, a pending-approvals list, and a 12-day
 * attendance bar chart for reviewers — leave balances for employees.
 *
 * Pure function of `data` (+ the org-wide trend fetch for reviewers). The
 * `team_attendance` / `pending_leaves` sections are populated only for
 * reviewers by the aggregator, so role-scoping is driven entirely off
 * `data.team_attendance != null` / `data.pending_leaves != null`.
 */

// ── Brand palette (matches the spike) ──────────────────────────────────────
const BG = '#0c0b0a';
const INK = '#f1ece1';
const MUTED = '#8c8576';
const CARD = '#16140f';
const BORDER = '#2b2823';
const BLUE = '#3f6bff';
const GREEN = '#3ec27a';
const PURPLE = '#b07bff';
const BAR_DIM = '#39342a';
const W = 880;

const SERIF = 'Playfair';
const SANS = 'Inter';

// ── Satori element helpers (ported from the spike) ─────────────────────────
type Node = { type: string; props: Record<string, unknown> };

const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
    type,
    props: { style, ...(children !== undefined ? { children } : {}) },
});
const row = (style: Record<string, unknown>, kids: unknown[]): Node => h('div', { display: 'flex', ...style }, kids);
const col = (style: Record<string, unknown>, kids: unknown[]): Node =>
    h('div', { display: 'flex', flexDirection: 'column', ...style }, kids);

// ── Field readers (tolerant of the loose Record shapes on HomeDashboardData) ─
const str = (v: unknown): string => (v == null ? '' : String(v));

/** First letter of each of the first two words of a name (e.g. "Sneha Patil" → "SP"). */
const initialsOf = (name: string): string =>
    name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w.charAt(0).toUpperCase())
        .join('') || '·';

interface Segment {
    check_in?: { time?: Date | string | null } | null;
    check_out?: { time?: Date | string | null } | null;
}

/** Build the sans status sub-line, mirroring the open/closed/none segment logic. */
const statusSub = (myToday: Record<string, unknown> | null): { text: string; open: boolean } => {
    const segs = (myToday?.segments as Segment[] | undefined) ?? [];
    const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
    const open = Boolean(lastSeg && !lastSeg.check_out);
    if (open) {
        const raw = segs[0]?.check_in?.time;
        const at = raw
            ? dayjs(raw as string | Date)
                  .tz(DEFAULT_TIMEZONE)
                  .format('HH:mm')
            : '—';
        return { text: `You checked in at ${at}`, open: true };
    }
    if (segs.length > 0) return { text: 'Done for today', open: false };
    return { text: "You haven't checked in yet", open: false };
};

// ── Reusable card sub-builders ─────────────────────────────────────────────
const kpiCard = (label: string, value: string, sub: string | null, dot: string): Node =>
    col({ background: CARD, borderRadius: 16, padding: 20, width: 384, border: `1px solid ${BORDER}` }, [
        row({ alignItems: 'center', marginBottom: 9 }, [
            h('div', { width: 8, height: 8, borderRadius: 8, background: dot, marginRight: 9 }),
            h(
                'div',
                { fontSize: 12, color: MUTED, fontFamily: SANS, fontWeight: 700, letterSpacing: 2 },
                label.toUpperCase()
            ),
        ]),
        row({ alignItems: 'baseline' }, [
            h('div', { fontSize: 44, fontFamily: SERIF, fontWeight: 700, color: INK }, value),
            ...(sub ? [h('div', { fontSize: 16, color: MUTED, fontFamily: SANS, marginLeft: 9 }, sub)] : []),
        ]),
    ]);

const avatar = (initials: string, c: string): Node =>
    h(
        'div',
        {
            display: 'flex',
            width: 40,
            height: 40,
            borderRadius: 40,
            background: c,
            alignItems: 'center',
            justifyContent: 'center',
            marginRight: 14,
        },
        [h('div', { color: '#fff', fontSize: 15, fontFamily: SANS, fontWeight: 700 }, initials)]
    );

const AVATAR_COLORS = [BLUE, GREEN, PURPLE];

const pendRow = (init: string, c: string, name: string, meta: string, last: boolean): Node =>
    row({ alignItems: 'center', padding: '12px 0', ...(last ? {} : { borderBottom: `1px solid ${BORDER}` }) }, [
        avatar(init, c),
        col({ flexGrow: 1 }, [
            h('div', { fontSize: 17, fontFamily: SERIF, fontWeight: 700, color: INK }, name),
            h('div', { fontSize: 13, color: MUTED, fontFamily: SANS, marginTop: 2 }, meta),
        ]),
        h(
            'div',
            {
                fontSize: 13,
                color: '#cdd8ff',
                fontFamily: SANS,
                fontWeight: 700,
                border: `1px solid ${BLUE}`,
                borderRadius: 8,
                padding: '7px 14px',
            },
            'Approve / Reject'
        ),
    ]);

const sectionLabel = (text: string, marginBottom: number): Node =>
    h('div', { fontSize: 12, color: MUTED, fontFamily: SANS, fontWeight: 700, letterSpacing: 2, marginBottom }, text);

const PENDING_RENDER_CAP = 10;

// ── Section builders ───────────────────────────────────────────────────────
const headerSection = (data: HomeDashboardData): Node => {
    const headline = dayjs().tz(DEFAULT_TIMEZONE).format('dddd, D MMMM');
    const status = statusSub(data.my_today);
    const pill = status.open
        ? row(
              {
                  alignItems: 'center',
                  background: '#11241a',
                  border: '1px solid #234c34',
                  borderRadius: 999,
                  padding: '8px 16px',
              },
              [
                  h('div', { width: 9, height: 9, borderRadius: 9, background: GREEN, marginRight: 8 }),
                  h('div', { fontSize: 14, color: '#8fe5b0', fontFamily: SANS, fontWeight: 700 }, 'Checked in'),
              ]
          )
        : row(
              {
                  alignItems: 'center',
                  background: '#1a1812',
                  border: `1px solid ${BORDER}`,
                  borderRadius: 999,
                  padding: '8px 16px',
              },
              [
                  h('div', { width: 9, height: 9, borderRadius: 9, background: MUTED, marginRight: 8 }),
                  h('div', { fontSize: 14, color: MUTED, fontFamily: SANS, fontWeight: 700 }, 'Not in'),
              ]
          );

    return row({ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }, [
        col({}, [
            h(
                'div',
                {
                    fontSize: 15,
                    color: BLUE,
                    fontFamily: SERIF,
                    fontWeight: 700,
                    fontStyle: 'italic',
                    marginBottom: 4,
                },
                'Attendance.'
            ),
            h('div', { fontSize: 34, fontFamily: SERIF, fontWeight: 700, color: INK }, headline),
            h('div', { fontSize: 15, color: MUTED, fontFamily: SANS, marginTop: 4 }, status.text),
        ]),
        pill,
    ]);
};

const teamSections = (data: HomeDashboardData): Node[] => {
    const team = data.team_attendance!;
    const out: Node[] = [];

    out.push(
        row({ justifyContent: 'space-between', marginBottom: 16 }, [
            kpiCard('Present today', String(team.present), `/ ${team.headcount}`, GREEN),
            kpiCard('On leave', String(team.on_leave), null, PURPLE),
        ])
    );

    const pending = data.pending_leaves;
    if (pending != null) {
        const total = data.pending_total ?? pending.length;
        const shown = pending.slice(0, PENDING_RENDER_CAP);
        const overflow = total - shown.length;
        const rows: Node[] = shown.map((p, i) => {
            const name = str((p as { user?: { full_name?: unknown } }).user?.full_name) || 'Someone';
            const code = str((p as { requested_leave_type?: { code?: unknown } }).requested_leave_type?.code) || '—';
            const meta = `${str(p.start_date)}–${str(p.end_date)} · ${code} · ${str(p.total_days)}d`;
            const isLast = i === shown.length - 1 && overflow <= 0;
            return pendRow(initialsOf(name), AVATAR_COLORS[i % AVATAR_COLORS.length]!, name, meta, isLast);
        });
        if (overflow > 0)
            rows.push(h('div', { fontSize: 13, color: MUTED, fontFamily: SANS, marginTop: 10 }, `+${overflow} more`));
        out.push(
            col({ background: CARD, borderRadius: 16, padding: 22, border: `1px solid ${BORDER}`, marginBottom: 16 }, [
                row({ alignItems: 'center', marginBottom: 4 }, [sectionLabel(`PENDING APPROVALS · ${total}`, 0)]),
                ...rows,
            ])
        );
    }

    return out;
};

const trendSection = (trend: Array<{ date: string; present: number }>): Node => {
    const max = Math.max(1, ...trend.map((t) => t.present));
    const last = trend.length - 1;
    const bars = trend.map((t, i) =>
        h('div', {
            width: 24,
            height: Math.max(2, Math.round((t.present / max) * 96)),
            borderRadius: 5,
            background: i === last ? BLUE : BAR_DIM,
            marginRight: 39,
        })
    );
    return col({ background: CARD, borderRadius: 16, padding: 22, border: `1px solid ${BORDER}` }, [
        sectionLabel('ATTENDANCE · LAST 12 DAYS', 14),
        row({ alignItems: 'flex-end', height: 96 }, bars),
    ]);
};

const employeeSection = (data: HomeDashboardData): Node => {
    const balances = (data.my_balances ?? []).filter((b) => Number((b as { available?: unknown }).available) > 0);
    if (balances.length === 0)
        return col({ background: CARD, borderRadius: 16, padding: 22, border: `1px solid ${BORDER}` }, [
            sectionLabel('LEAVE BALANCE', 12),
            h('div', { fontSize: 16, color: MUTED, fontFamily: SANS }, 'No leave balance'),
        ]);

    const tiles = balances.map((b) => {
        const code = str((b as { leave_type?: { code?: unknown } }).leave_type?.code) || '—';
        const available = str((b as { available?: unknown }).available);
        return col(
            {
                background: '#1a1812',
                borderRadius: 12,
                padding: '14px 18px',
                border: `1px solid ${BORDER}`,
                marginRight: 14,
                marginBottom: 14,
                alignItems: 'flex-start',
            },
            [
                h('div', { fontSize: 32, fontFamily: SERIF, fontWeight: 700, color: INK }, available),
                h(
                    'div',
                    { fontSize: 12, color: MUTED, fontFamily: SANS, fontWeight: 700, letterSpacing: 2, marginTop: 2 },
                    code.toUpperCase()
                ),
            ]
        );
    });

    return col({ background: CARD, borderRadius: 16, padding: 22, border: `1px solid ${BORDER}` }, [
        sectionLabel('LEAVE BALANCE', 14),
        row({ flexWrap: 'wrap' }, tiles),
    ]);
};

// ── Public entry point ─────────────────────────────────────────────────────
export const renderHomeDashboardPng = async (
    data: HomeDashboardData,
    _user: { _id: Types.ObjectId; role?: string; full_name?: string | null }
): Promise<Buffer> => {
    const children: Node[] = [headerSection(data)];

    if (data.team_attendance != null) {
        children.push(...teamSections(data));
        const trend = await getAttendanceTrend(12);
        children.push(trendSection(trend));
    } else {
        children.push(employeeSection(data));
    }

    const tree = col({ width: W, padding: 36, background: BG, fontFamily: SANS }, children);

    const fonts = loadHomeFonts();
    if (fonts.length === 0) throw new Error('SLACK_HOME_FONTS_MISSING');

    const svg = await satori(tree as unknown as Parameters<typeof satori>[0], { width: W, fonts });
    return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng());
};

// ── Hosted-image cache (render → Azure Blob → SAS URL) ───────────────────────
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { url: string; exp: number }>();

/** Test seam: drop the per-user SAS-URL cache. */
export const __resetHomeImageCache = (): void => cache.clear();

/**
 * Render → upload to Azure Blob → return a short-lived SAS URL for the Slack
 * Home dashboard image. Per-user cached for CACHE_TTL_MS unless `force`.
 * Returns null (never throws) when Azure is unconfigured or any step fails —
 * the caller then falls back to the native Block Kit dashboard.
 */
export const getOrRenderHomeImageUrl = async (
    user: { _id: Types.ObjectId; role?: string; full_name?: string | null },
    data: HomeDashboardData,
    opts: { force?: boolean } = {}
): Promise<string | null> => {
    const key = user._id.toString();
    if (!opts.force) {
        const hit = cache.get(key);
        if (hit && hit.exp > Date.now()) return hit.url;
    }
    if (!isAzureConfigured()) return null;
    try {
        const png = await renderHomeDashboardPng(data, user);
        const blobKey = `slack-home/${key}/${ulid()}.png`;
        await putBlob({
            container: AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER,
            blobKey,
            body: png,
            contentType: 'image/png',
        });
        // No `fileName` → no `Content-Disposition: attachment`. Slack's image
        // proxy must render these bytes inline; the upload-pinned
        // `Content-Type: image/png` governs. An attachment disposition would
        // tell the proxy to download-not-display and can blank the image block.
        const { url } = mintDownloadSas({
            container: AZURE_BLOB_TASK_ATTACHMENTS_CONTAINER,
            blobKey,
            ttlMinutes: 60,
        });
        cache.set(key, { url, exp: Date.now() + CACHE_TTL_MS });
        return url;
    } catch (err) {
        logger.warn(
            { err, code: 'SLACK_HOME_IMAGE_FAILED', user_id: key },
            'Slack Home dashboard image render/upload failed'
        );
        return null;
    }
};
