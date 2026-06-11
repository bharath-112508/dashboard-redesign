// src/utils/caller-permissions.ts
import { PERMISSIONS, type Permission } from '../constants/permissions.js';

/**
 * Service-layer permission check for the analytics dashboard (spec §7).
 * Mirrors `requirePermission` middleware semantics: `system.admin` is a
 * wildcard; pre-Step-47 tokens (no permissions claim) hold nothing.
 */
export const callerCan = (held: readonly string[] | undefined, perm: Permission): boolean =>
    !!held && (held.includes(PERMISSIONS.SYSTEM_ADMIN) || held.includes(perm));
