import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { pickCoverAttachments } from './task-attachment.service.js';

const oid = () => new Types.ObjectId();

describe('pickCoverAttachments', () => {
    const t1 = oid();
    const t2 = oid();
    const t3 = oid();
    const att = (task: Types.ObjectId, mime: string, at: string, key: string) => ({
        task_id: task,
        mime_type: mime,
        created_at: new Date(at),
        blob_container: 'c',
        blob_key: key,
    });

    it('picks the newest image per task and skips non-images', () => {
        const m = pickCoverAttachments([
            att(t1, 'image/png', '2026-10-01', 'old'),
            att(t1, 'image/jpeg', '2026-10-05', 'new'),
            att(t1, 'application/pdf', '2026-10-09', 'pdf'),
            att(t2, 'text/plain', '2026-10-02', 'txt'),
            att(t3, 'image/webp', '2026-10-03', 'only'),
        ]);
        expect(m.get(t1.toString())?.blob_key).toBe('new');
        expect(m.has(t2.toString())).toBe(false);
        expect(m.get(t3.toString())?.blob_key).toBe('only');
    });

    it('ignores image types browsers may not render safely (svg)', () => {
        const m = pickCoverAttachments([att(t1, 'image/svg+xml', '2026-10-01', 'svg')]);
        expect(m.size).toBe(0);
    });
});
