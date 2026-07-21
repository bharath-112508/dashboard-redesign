import { describe, expect, it } from 'vitest';

import { pickCustomStatusKey, slugifyCustomStatusKey } from './custom-status-key.js';

const KEY_REGEX = /^[a-z][a-z0-9_]{0,39}$/;

describe('slugifyCustomStatusKey', () => {
    it('lower_snakes a normal label', () => {
        expect(slugifyCustomStatusKey('Ready for QA')).toBe('ready_for_qa');
        expect(slugifyCustomStatusKey('In Review')).toBe('in_review');
    });

    it('collapses punctuation and repeated separators', () => {
        expect(slugifyCustomStatusKey('  Blocked / On-hold!! ')).toBe('blocked_on_hold');
    });

    it('drops a leading number so the key starts with a letter', () => {
        expect(slugifyCustomStatusKey('3rd pass')).toBe('rd_pass');
        expect(slugifyCustomStatusKey('2026 planning')).toBe('planning');
    });

    it('falls back to "status" when nothing usable remains', () => {
        expect(slugifyCustomStatusKey('123')).toBe('status');
        expect(slugifyCustomStatusKey('   ')).toBe('status');
    });

    it('always returns a regex-valid key', () => {
        for (const label of ['Ready for QA', '3rd pass', '!!!', 'DONE', 'a', 'Über Cool']) {
            expect(slugifyCustomStatusKey(label)).toMatch(KEY_REGEX);
        }
    });
});

describe('pickCustomStatusKey', () => {
    it('returns the base when free', () => {
        expect(pickCustomStatusKey('ready_for_qa', new Set())).toBe('ready_for_qa');
    });

    it('avoids the built-in default keys', () => {
        expect(pickCustomStatusKey('done', new Set())).toBe('done_2');
        expect(pickCustomStatusKey('review', new Set())).toBe('review_2');
    });

    it('appends the smallest free suffix on collision with existing keys', () => {
        expect(pickCustomStatusKey('qa', new Set(['qa']))).toBe('qa_2');
        expect(pickCustomStatusKey('qa', new Set(['qa', 'qa_2', 'qa_3']))).toBe('qa_4');
    });
});
