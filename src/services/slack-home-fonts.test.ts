import { describe, expect, it } from 'vitest';

import { loadHomeFonts } from './slack-home-fonts.js';

describe('loadHomeFonts', () => {
    it('loads serif + sans fonts as satori font descriptors', () => {
        const fonts = loadHomeFonts();
        expect(Array.isArray(fonts)).toBe(true);
        expect(fonts.length).toBeGreaterThanOrEqual(3);
        for (const f of fonts) {
            expect(typeof f.name).toBe('string');
            expect(Buffer.isBuffer(f.data) || (f.data as unknown) instanceof ArrayBuffer).toBe(true);
            expect([400, 700]).toContain(f.weight);
        }
        const names = new Set(fonts.map((f) => f.name));
        expect(names.has('Inter')).toBe(true);
        expect(names.has('Playfair')).toBe(true);
    });
});
