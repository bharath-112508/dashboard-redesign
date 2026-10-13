import { getOrInitSettings } from './settings.service.js';
import { recordAudit } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import type { ProjectCaller } from './project.service.js';

/**
 * Redesign: the app's Roles & permissions grid and its developer types,
 * stored in system settings. Display only — real access is decided by the
 * backend's own role permissions, which this does not change.
 */
export interface AppAccess {
    perms: Record<string, string[]> | null;
    dev_types: string[] | null;
}

export const getAppAccess = async (): Promise<AppAccess> => {
    const s = await getOrInitSettings();
    return { perms: s.app_access?.perms ?? null, dev_types: s.app_access?.dev_types ?? null };
};

/** Saves the parts given; a part that is not sent is kept. */
export const setAppAccess = async (body: Partial<AppAccess>, caller: ProjectCaller): Promise<AppAccess> => {
    const s = await getOrInitSettings();
    const before = { perms: s.app_access?.perms ?? null, dev_types: s.app_access?.dev_types ?? null };
    const after: AppAccess = {
        // Per role: saving one role's ticks keeps the others.
        perms: body.perms !== undefined ? { ...(before.perms ?? {}), ...body.perms } : before.perms,
        dev_types: body.dev_types !== undefined ? body.dev_types : before.dev_types,
    };
    s.app_access = after;
    s.markModified('app_access');
    await s.save();
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.SETTINGS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: s._id },
            before: { app_access: before },
            after: { app_access: after },
        });
    }
    return after;
};
