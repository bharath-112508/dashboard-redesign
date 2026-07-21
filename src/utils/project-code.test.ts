import { describe, expect, it } from 'vitest';

import { deriveProjectCodeBase, pickProjectCode } from './project-code.js';

describe('deriveProjectCodeBase', () => {
    it('takes initials of the significant words for a multi-word name', () => {
        expect(deriveProjectCodeBase('Atlas CRM Migration')).toBe('ACM');
        expect(deriveProjectCodeBase('Nordmark Fleet Dashboard')).toBe('NFD');
        expect(deriveProjectCodeBase('Cold Chain Telemetry')).toBe('CCT');
    });

    it('drops pure-number tokens so they never form a digit initial', () => {
        expect(deriveProjectCodeBase('Website Redesign 2026')).toBe('WR');
    });

    it('takes the first three letters of a single-word name', () => {
        expect(deriveProjectCodeBase('Vilje')).toBe('VIL');
        expect(deriveProjectCodeBase('Atlas')).toBe('ATL');
    });

    it('ignores filler stopwords unless the name is only stopwords', () => {
        expect(deriveProjectCodeBase('Bank of America')).toBe('BA');
        // all-stopword name still yields something valid
        expect(deriveProjectCodeBase('The And')).toMatch(/^[A-Z][A-Z0-9]*$/);
    });

    it('always returns an uppercase, letter-leading, regex-valid base', () => {
        const regex = /^[A-Z][A-Z0-9_-]{0,39}$/;
        for (const name of ['2026', '  ', '99 Bottles', 'a', 'X-Wing Program']) {
            expect(deriveProjectCodeBase(name)).toMatch(regex);
        }
    });

    it('falls back to PRJ for a name with no letters', () => {
        expect(deriveProjectCodeBase('2026')).toBe('PRJ');
    });
});

describe('pickProjectCode', () => {
    it('returns the base when nothing is taken', () => {
        expect(pickProjectCode('WR', new Set())).toBe('WR');
    });

    it('appends the smallest free number on collision', () => {
        expect(pickProjectCode('WR', new Set(['WR']))).toBe('WR2');
        expect(pickProjectCode('WR', new Set(['WR', 'WR2', 'WR3']))).toBe('WR4');
    });

    it('skips a gap-free run and lands on the first hole', () => {
        expect(pickProjectCode('WR', new Set(['WR', 'WR2', 'WR4']))).toBe('WR3');
    });

    it('compares case-insensitively', () => {
        expect(pickProjectCode('WR', new Set(['wr', 'wr2']))).toBe('WR3');
    });
});
