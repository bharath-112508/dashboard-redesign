import { SLACK_ACTION_ATTENDANCE_CHECK_IN, SLACK_ACTION_ATTENDANCE_CHECK_OUT } from '../constants/slack.js';

/**
 * Pure Block Kit builders for the Slack attendance surfaces (App Home tab
 * + the two DM nudges). No I/O, no settings reads — given a today's
 * attendance record (the `getMyToday` JSON shape) they return Block Kit
 * JSON. Kept separate from the controller so the states are unit-testable
 * without HTTP.
 */

interface Punch {
    time?: Date | string | null;
}
interface Segment {
    check_in?: Punch | null;
    check_out?: Punch | null;
}
interface TodayRecord {
    segments?: Segment[] | null;
    total_worked_minutes?: number | null;
}

const toDate = (raw: Date | string | null | undefined): Date | null =>
    raw instanceof Date ? raw : raw ? new Date(raw) : null;

/** Format a UTC instant as `HH:MM` in IST (matches the slash-command output). */
export const formatTimeIST = (d: Date): string =>
    new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(d);

/** Format a minute count as `Xh Ym`. */
export const formatDuration = (minutes: number): string => {
    const safe = Math.max(0, Math.round(minutes));
    return `${Math.floor(safe / 60)}h ${safe % 60}m`;
};

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

const checkInButton = () => ({
    type: 'actions',
    elements: [
        {
            type: 'button',
            text: { type: 'plain_text', text: 'Check In', emoji: true },
            style: 'primary',
            action_id: SLACK_ACTION_ATTENDANCE_CHECK_IN,
        },
    ],
});

const checkOutButton = () => ({
    type: 'actions',
    elements: [
        {
            type: 'button',
            text: { type: 'plain_text', text: 'Check Out', emoji: true },
            style: 'danger',
            action_id: SLACK_ACTION_ATTENDANCE_CHECK_OUT,
        },
    ],
});

/** Render the segment list as bullet lines: `11:03 → 18:30` / `11:03 → now`. */
const segmentLines = (segments: Segment[]): string =>
    segments
        .map((s) => {
            const inT = toDate(s.check_in?.time);
            const outT = toDate(s.check_out?.time);
            return `• ${inT ? formatTimeIST(inT) : '—'} → ${outT ? formatTimeIST(outT) : 'now'}`;
        })
        .join('\n');

/**
 * The header/status/button blocks for the attendance panel — shared by the
 * standalone Home view and the richer Home dashboard so the check-in/out UI
 * is defined once.
 */
export const attendanceHeaderBlocks = (
    record: TodayRecord | null,
    displayName: string
): Array<Record<string, unknown>> => {
    const segs = record?.segments ?? [];
    const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
    const isOpen = Boolean(lastSeg && !lastSeg.check_out);
    const worked = record?.total_worked_minutes ?? 0;

    const blocks: Array<Record<string, unknown>> = [
        section(`*Attendance* — hi ${displayName} :wave:`),
        { type: 'divider' },
    ];

    if (isOpen) {
        const inT = toDate(lastSeg!.check_in?.time);
        blocks.push(section(`:large_green_circle: Checked in since *${inT ? formatTimeIST(inT) : '—'}*`));
        blocks.push(section(segmentLines(segs)));
        blocks.push(checkOutButton());
    } else if (segs.length > 0) {
        blocks.push(section(`:white_check_mark: Done for today · *${formatDuration(worked)}* worked`));
        blocks.push(section(segmentLines(segs)));
        blocks.push(checkInButton());
    } else {
        blocks.push(section("You haven't checked in yet today."));
        blocks.push(checkInButton());
    }
    return blocks;
};

/**
 * App Home tab. Three states, each surfacing only the valid button so the
 * Home UI itself can't trigger an invalid action:
 *   - no open segment & no segments → "Check In"
 *   - latest segment open           → "Check Out"
 *   - all segments closed           → "Check In" (start a new segment)
 */
export const buildAttendanceHomeView = (record: TodayRecord | null, displayName: string): Record<string, unknown> => ({
    type: 'home',
    blocks: attendanceHeaderBlocks(record, displayName),
});

export interface NudgeMessage {
    text: string;
    blocks: Array<Record<string, unknown>>;
}

/** Morning check-in nudge DM. */
export const buildCheckinNudgeMessage = (displayName: string): NudgeMessage => ({
    text: 'Ready to check in?',
    blocks: [section(`Morning ${displayName}! Ready to start your day?`), checkInButton()],
});

/** Evening "forgot to check out?" reminder DM. */
export const buildCheckoutReminderMessage = (checkedInAt: Date): NudgeMessage => ({
    text: 'Forgot to check out?',
    blocks: [
        section(`You're still checked in from *${formatTimeIST(checkedInAt)}*. Forgot to check out?`),
        checkOutButton(),
    ],
});
