// src/services/dashboard-insights.ts

/**
 * Plain-language insight + delta builders (spec §6). Pure functions —
 * deterministic, no I/O, no LLM. The FE renders these strings verbatim,
 * so phrasing changes are BE-only.
 *
 * Convention: range labels arrive as the ResolvedRange.label ('This
 * month') and are lowercased inline ('… this month.').
 */

export interface SectionDelta {
    /** Rounded percent change vs the previous period. */
    pct: number;
    direction: 'up' | 'down' | 'flat';
    /** 'good'/'bad' drives FE tint (forest/coral); neutral = grey. */
    tone: 'good' | 'bad' | 'neutral';
    label: string;
}

export const buildDelta = (
    current: number,
    previous: number,
    prevLabel: string,
    goodWhen: 'up' | 'down' | 'neutral'
): SectionDelta | null => {
    if (previous <= 0) return null; // no comparison base
    const pct = Math.round(((current - previous) / previous) * 100);
    if (pct === 0) {
        return { pct: 0, direction: 'flat', tone: 'neutral', label: `same as ${prevLabel}` };
    }
    const direction = pct > 0 ? 'up' : 'down';
    const tone = goodWhen === 'neutral' ? 'neutral' : direction === goodWhen ? 'good' : 'bad';
    return { pct, direction, tone, label: `${pct > 0 ? '+' : ''}${pct}% vs ${prevLabel}` };
};

const low = (rangeLabel: string): string => rangeLabel.charAt(0).toLowerCase() + rangeLabel.slice(1);

export const minutesToHoursLabel = (minutes: number): string => `${Math.round(minutes / 60)}h`;

export const attendanceTrendInsight = (avgPresent: number, total: number, rangeLabel: string): string =>
    total === 0
        ? `No attendance recorded ${low(rangeLabel)}.`
        : `About ${Math.round(avgPresent)} of ${total} people were in each day ${low(rangeLabel)}.`;

export const employeeAttendanceInsight = (present: number, workingDays: number, rangeLabel: string): string =>
    workingDays === 0
        ? `No working days ${low(rangeLabel)} yet.`
        : `You were in ${present} of ${workingDays} working days ${low(rangeLabel)}.`;

export const leaveMixInsight = (rows: { name: string | null; days: number }[], rangeLabel: string): string => {
    if (rows.length === 0) return `No leaves taken ${low(rangeLabel)}.`;
    const total = rows.reduce((a, r) => a + r.days, 0);
    const top = [...rows].sort((a, b) => b.days - a.days)[0];
    return `${total} leave day${total === 1 ? '' : 's'} ${low(rangeLabel)} — mostly ${top.name ?? 'unnamed'} (${top.days}).`;
};

export const hoursByProjectInsight = (
    topName: string,
    topMinutes: number,
    totalMinutes: number,
    rangeLabel: string
): string => {
    if (totalMinutes === 0) return `No hours logged ${low(rangeLabel)}.`;
    const share = Math.round((topMinutes / totalMinutes) * 100);
    return `${topName} took the most time ${low(rangeLabel)} — ${minutesToHoursLabel(topMinutes)}, about ${share}% of all hours.`;
};

export const hoursLoggedInsight = (totalMinutes: number, rangeLabel: string): string =>
    totalMinutes === 0
        ? `No hours logged ${low(rangeLabel)}.`
        : `${minutesToHoursLabel(totalMinutes)} logged ${low(rangeLabel)}.`;

export const pendingApprovalsInsight = (count: number, oldestDays: number): string => {
    if (count === 0) return 'Nothing waiting on you.';
    const noun = count === 1 ? 'leave' : 'leaves';
    if (oldestDays <= 0) return `${count} ${noun} waiting — ${count === 1 ? 'it' : 'the oldest'} came in today.`;
    return `${count} ${noun} waiting — the oldest has been pending ${oldestDays} day${oldestDays === 1 ? '' : 's'}.`;
};

export const tasksByStatusInsight = (done: number, total: number, _rangeLabel: string): string =>
    total === 0
        ? 'No tasks in scope yet.'
        : `${done} of ${total} tasks are done — ${Math.round((done / total) * 100)}%.`;

export const utilizationInsight = (pct: number, rangeLabel: string): string =>
    `The team worked ${pct}% of expected hours ${low(rangeLabel)}.`;

export const throughputInsight = (completed: number, rangeLabel: string): string =>
    completed === 0
        ? `No tasks completed ${low(rangeLabel)} yet.`
        : `${completed} task${completed === 1 ? '' : 's'} completed ${low(rangeLabel)}.`;

export const projectProgressInsight = (projects: number, done: number, total: number): string =>
    projects === 0
        ? 'No projects yet.'
        : total === 0
          ? `${projects} project${projects === 1 ? '' : 's'}, no tasks created yet.`
          : `${done} of ${total} tasks done across ${projects} project${projects === 1 ? '' : 's'}.`;

export const leaveBalancesInsight = (totalAvailable: number): string =>
    totalAvailable <= 0
        ? 'No leave days left this year.'
        : `${totalAvailable} leave day${totalAvailable === 1 ? '' : 's'} still available this year.`;
