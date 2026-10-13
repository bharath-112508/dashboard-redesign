import { describe, expect, it } from 'vitest';

import { createCompanyBodySchema, createRepresentativeBodySchema, patchCompanyBodySchema } from './company.validator.js';

const USER_ID = '665f1c2e9b1d8a0012ab34cd';

describe('company profile fields', () => {
    it('accepts the profile fields and staff on a company on create and patch', () => {
        const body = {
            industry: 'Retail',
            country: 'Sweden',
            website: 'https://aurora.example',
            notes: 'Prefers email.',
            logo: 'data:image/png;base64,AAAA',
            responsibles: [{ user_id: USER_ID, role: 'developer' }],
        };
        expect(createCompanyBodySchema.safeParse({ name: 'Aurora', ...body }).success).toBe(true);
        expect(patchCompanyBodySchema.safeParse(body).success).toBe(true);
    });

    it('rejects an unknown staff role', () => {
        expect(patchCompanyBodySchema.safeParse({ responsibles: [{ user_id: USER_ID, role: 'owner' }] }).success).toBe(false);
    });

    it('rejects a logo larger than 200 KB', () => {
        expect(patchCompanyBodySchema.safeParse({ logo: 'x'.repeat(200 * 1024 + 1) }).success).toBe(false);
    });

    it('still rejects unknown keys', () => {
        expect(patchCompanyBodySchema.safeParse({ colour: 'red' }).success).toBe(false);
    });
});

describe('client contact title', () => {
    it('accepts an optional title for a new contact', () => {
        const base = { email: 'kari@nordlys.no', full_name: 'Kari Berg', initial_password: 'x'.repeat(12) };
        expect(createRepresentativeBodySchema.safeParse({ ...base, title: 'Head of digital' }).success).toBe(true);
        expect(createRepresentativeBodySchema.safeParse({ ...base, title: 'x'.repeat(101) }).success).toBe(false);
    });
});

describe('company logo', () => {
    it.each(['', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/webp;base64,UklGR'])(
        'accepts %s',
        (logo) => {
            expect(patchCompanyBodySchema.safeParse({ logo }).success).toBe(true);
        }
    );

    it.each(['https://tracker.example/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGgxPg==', 'data:image/png,notbase64', 'data:image/svg+xml;base64,PHN2Zz4='])(
        'rejects %s — a logo must be an embedded image, never a link',
        (logo) => {
            expect(patchCompanyBodySchema.safeParse({ logo }).success).toBe(false);
        }
    );
});


describe('createRepresentativeBodySchema — invite', () => {
    it('accepts send_invite', () => {
        const base = { email: 'kari@nordlys.no', full_name: 'Kari Berg', initial_password: 'x'.repeat(12) };
        const r = createRepresentativeBodySchema.safeParse({ ...base, send_invite: true });
        expect(r.success && r.data.send_invite).toBe(true);
    });
});
