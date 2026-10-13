import { describe, expect, it } from 'vitest';

import { codeFromName, uniqueCodeFromName } from './leave-type-code.js';

// The create form no longer collects a code, so whatever this emits is what
// gets persisted as a permanent business key — it must always satisfy the
// validator's codeSchema: /^[A-Z][A-Z0-9_]*$/, 2..32 chars.
const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

describe('codeFromName', () => {
    it('upper-snakes a plain name', () => {
        expect(codeFromName('Bereavement leave')).toBe('BEREAVEMENT_LEAVE');
    });

    it('collapses punctuation and repeated separators', () => {
        expect(codeFromName('Work  from-home (WFH)')).toBe('WORK_FROM_HOME_WFH');
    });

    it('drops leading non-letters — a code may not start with a digit', () => {
        expect(codeFromName('2nd shift leave')).toBe('ND_SHIFT_LEAVE');
    });

    it('never emits a trailing underscore, including after the 32-char clamp', () => {
        expect(codeFromName('Sabbatical ')).toBe('SABBATICAL');
        expect(codeFromName('Aaaaaaaaaa bbbbbbbbbb cccccccccc dddd')).toBe('AAAAAAAAAA_BBBBBBBBBB_CCCCCCCCCC');
    });

    it('falls back when the name yields nothing usable', () => {
        for (const name of ['', '   ', '!!!', '2', '日本語']) {
            expect(codeFromName(name)).toBe('LEAVE_TYPE');
        }
    });

    it('always emits a code the validator accepts', () => {
        for (const name of [
            'Bereavement leave',
            '2nd shift',
            '!!!',
            '',
            'x',
            '日本語',
            'A'.repeat(80),
            'Ünïcödé leave',
            '___',
        ]) {
            const code = codeFromName(name);
            expect(code, `name: ${name}`).toMatch(CODE_RE);
            expect(code.length).toBeGreaterThanOrEqual(2);
            expect(code.length).toBeLessThanOrEqual(32);
        }
    });
});

describe('uniqueCodeFromName', () => {
    it('returns the plain code when nothing is taken', () => {
        expect(uniqueCodeFromName('Bereavement leave', new Set())).toBe('BEREAVEMENT_LEAVE');
    });

    // Without a code field there is no way for the admin to resolve a clash
    // by hand, so a repeated name must not dead-end on the unique index.
    it('suffixes past every taken variant', () => {
        const taken = new Set(['BEREAVEMENT_LEAVE', 'BEREAVEMENT_LEAVE_2']);
        expect(uniqueCodeFromName('Bereavement leave', taken)).toBe('BEREAVEMENT_LEAVE_3');
    });

    it('keeps the suffixed code inside 32 chars and still valid', () => {
        const base = codeFromName('Aaaaaaaaaa bbbbbbbbbb cccccccccc dddd'); // exactly 32
        const code = uniqueCodeFromName('Aaaaaaaaaa bbbbbbbbbb cccccccccc dddd', new Set([base]));
        expect(code.length).toBeLessThanOrEqual(32);
        expect(code).toMatch(CODE_RE);
        expect(code).not.toBe(base);
    });

    it('suffixes the fallback too, so unusable names still differ', () => {
        expect(uniqueCodeFromName('!!!', new Set(['LEAVE_TYPE']))).toBe('LEAVE_TYPE_2');
    });
});
