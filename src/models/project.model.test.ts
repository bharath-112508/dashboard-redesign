import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { Project } from './project.model.js';

describe('Project default_status_orders safety net', () => {
    it('a project stored with the old four built-ins validates, gaining bug at 250', async () => {
        const doc = new Project({
            name: 'Legacy',
            code: 'LEG',
            created_by: new Types.ObjectId(),
            default_status_orders: [
                { key: 'to_do', order: 100, is_active: true },
                { key: 'in_progress', order: 200, is_active: true },
                { key: 'review', order: 300, is_active: true },
                { key: 'done', order: 400, is_active: true },
            ],
        });
        await expect(doc.validate(['default_status_orders'])).resolves.toBeUndefined();
        expect(doc.default_status_orders.map((o) => [o.key, o.order, o.is_active])).toContainEqual(['bug', 250, true]);
    });
});
