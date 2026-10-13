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
