// src/services/dashboard-insights.test.ts
import { describe, expect, it } from 'vitest';

import {
    buildDelta,
    attendanceTrendInsight,
    leaveMixInsight,
    hoursByProjectInsight,
    pendingApprovalsInsight,
    hoursLoggedInsight,
    tasksByStatusInsight,
    utilizationInsight,
    throughputInsight,
} from './dashboard-insights.js';

describe('buildDelta', () => {
    it('computes pct, direction, tone (goodWhen=up)', () => {
        expect(buildDelta(110, 100, 'last month', 'up')).toEqual({
            pct: 10,
            direction: 'up',
            tone: 'good',
            label: '+10% vs last month',
        });
    });
    it('down + goodWhen=down → good', () => {
        expect(buildDelta(80, 100, 'yesterday', 'down')).toEqual({
            pct: -20,
            direction: 'down',
            tone: 'good',
            label: '-20% vs yesterday',
        });
    });
    it('flat within rounding → neutral', () => {
        expect(buildDelta(100, 100, 'last week', 'up')).toEqual({
            pct: 0,
            direction: 'flat',
            tone: 'neutral',
            label: 'same as last week',
        });
    });
    it('null when previous period has no data', () => {
        expect(buildDelta(50, 0, 'last month', 'up')).toBeNull();
    });
});

describe('insight sentences', () => {
    it('attendance: average + steady phrasing', () => {
        expect(attendanceTrendInsight(34.2, 40, 'This month')).toBe(
            'About 34 of 40 people were in each day this month.'
        );
    });
    it('attendance: empty', () => {
        expect(attendanceTrendInsight(0, 0, 'This week')).toBe('No attendance recorded this week.');
    });
    it('hours by project: top share', () => {
        expect(hoursByProjectInsight('Platform', 412 * 60, 1030 * 60, 'This month')).toBe(
            'Platform took the most time this month — 412h, about 40% of all hours.'
        );
    });
    it('pending approvals: oldest age', () => {
        expect(pendingApprovalsInsight(7, 3)).toBe('7 leaves waiting — the oldest has been pending 3 days.');
        expect(pendingApprovalsInsight(0, 0)).toBe('Nothing waiting on you.');
        expect(pendingApprovalsInsight(1, 0)).toBe('1 leave waiting — it came in today.');
    });
    it('leave mix empty', () => {
        expect(leaveMixInsight([], 'This month')).toBe('No leaves taken this month.');
    });
    it('hours logged', () => {
        expect(hoursLoggedInsight(142 * 60, 'This month')).toBe('142h logged this month.');
    });
    it('tasks by status', () => {
        expect(tasksByStatusInsight(128, 336, 'This month')).toBe('128 of 336 tasks are done — 38%.');
        expect(tasksByStatusInsight(0, 0, 'Today')).toBe('No tasks in scope yet.');
    });
    it('utilization', () => {
        expect(utilizationInsight(82, 'This month')).toBe('The team worked 82% of expected hours this month.');
    });
    it('throughput', () => {
        expect(throughputInsight(128, 'This month')).toBe('128 tasks completed this month.');
    });
});
