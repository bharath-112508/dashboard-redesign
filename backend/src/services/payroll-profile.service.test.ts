import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../models/payroll-profile.model.js', () => ({
    PayrollProfile: { findOne: vi.fn(), findOneAndUpdate: vi.fn(), find: vi.fn(), countDocuments: vi.fn() },
}));
vi.mock('../models/user.model.js', () => ({ User: { exists: vi.fn() } }));
vi.mock('./audit.service.js', () => ({ recordAudit: vi.fn() }));

import { Types } from 'mongoose';
import { PayrollProfile } from '../models/payroll-profile.model.js';
import { User } from '../models/user.model.js';
import * as service from './payroll-profile.service.js';

const uid = new Types.ObjectId();
const caller = { id: new Types.ObjectId(), audit: { actor_id: new Types.ObjectId() } as never };

beforeEach(() => vi.clearAllMocks());

describe('upsertProfile', () => {
    it('404s when the user does not exist', async () => {
        (User.exists as never as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        await expect(service.upsertProfile(uid, { pan: 'X' } as never, caller)).rejects.toThrow(/not found/i);
    });

    it('upserts and returns the profile when the user exists', async () => {
        (User.exists as never as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: uid });
        const doc = { toJSON: () => ({ user_id: uid.toString(), pan: 'CZQPG6515F' }) };
        (PayrollProfile.findOneAndUpdate as never as ReturnType<typeof vi.fn>).mockResolvedValue(doc);
        const out = await service.upsertProfile(uid, { pan: 'CZQPG6515F' } as never, caller);
        expect(out.pan).toBe('CZQPG6515F');
    });
});
