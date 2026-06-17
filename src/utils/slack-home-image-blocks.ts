import { buildHomeInteractiveBlocks } from './slack-home-blocks.js';
import type { DashboardUser, HomeDashboardData } from '../services/slack-home.service.js';

/**
 * Image-rendered Slack Home view. The branded PNG (Satori → resvg → Azure Blob
 * SAS URL, built by `services/slack-home-image.service.ts`) carries ALL the
 * data display — header, KPI cards, pending list, charts/balances. It sits at
 * the TOP of the Home tab as a single `image` block; the INTERACTIVE controls
 * stay as Block Kit BELOW it, because Slack can't embed buttons inside an image.
 *
 * The controls are produced by `buildHomeInteractiveBlocks` — the exact same
 * fragment builders the native (`buildHomeDashboardView`) view uses — so the
 * Check In/Out, Approve/Reject (action_ids `approve_leave_<id>` /
 * `reject_leave_<id>`), and Refresh buttons hit the same controller handlers.
 */
export const buildImageHomeView = (
    imageUrl: string,
    data: HomeDashboardData,
    user: DashboardUser
): Record<string, unknown> => {
    const blocks: Array<Record<string, unknown>> = [
        { type: 'image', image_url: imageUrl, alt_text: 'Attendance dashboard' },
        { type: 'divider' },
        ...buildHomeInteractiveBlocks(data, user),
    ];
    return { type: 'home', blocks: blocks.slice(0, 100) };
};
