import { describe, it, expect } from 'vitest';

import { Story } from './story.model.js';

const OID = '6a32a6d1fae64e468a3dc592';

describe('Story model', () => {
    // `description` was `required: true` alongside `default: ''` — a pair
    // Mongoose can never satisfy, because an empty string fails its `required`
    // check for a String. The create dialog omits the field when the box is
    // blank and the validator defaults it to '', so every epic created without
    // a description 400'd with "Path `description` is required."
    it('accepts an epic with no description', () => {
        const s = new Story({ project_id: OID, title: 'Checkout revamp', created_by: OID });

        expect(s.validateSync()?.errors.description).toBeUndefined();
        expect(s.description).toBe('');
    });

    it('accepts an explicitly empty description', () => {
        const s = new Story({ project_id: OID, title: 'Checkout revamp', description: '', created_by: OID });

        expect(s.validateSync()?.errors.description).toBeUndefined();
    });

    it('still requires a title', () => {
        const s = new Story({ project_id: OID, created_by: OID });

        expect(s.validateSync()?.errors.title).toBeDefined();
    });
});
