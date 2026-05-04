/**
 * Task-attachment constants (Data_Model.md §5.6, API_Contract.md §8.5,
 * BUILD_PROGRESS.md Step 21).
 *
 * Attachments are *project-scoped* — anyone with project read access can
 * upload, list, and download; only the uploader OR an admin/manager can
 * delete (per BUILD_PROGRESS Step 21 + the moderator pattern from Step 19).
 *
 * Size + MIME caps are pulled from `system_settings.uploads.*` at runtime
 * so an admin can update the policy without a redeploy. The constants
 * here only cover field caps, pagination, and the route-level role gate.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── Field caps ──────────────────────────────────────────────────────────
//
// The display name is a separate field from the blob key — we store the
// original filename verbatim (truncated) so the FE can render it in the
// task detail panel. The blob key uses a sanitised + uniquified version
// (see `service.buildBlobKey`).

export const ATTACHMENT_FILE_NAME_MAX = 255;
export const ATTACHMENT_MIME_TYPE_MAX = 200;

// ─── Pagination ──────────────────────────────────────────────────────────

export const ATTACHMENT_LIST_DEFAULT_LIMIT = 20;
export const ATTACHMENT_LIST_MAX_LIMIT = 100;

// ─── SAS TTL clamps ──────────────────────────────────────────────────────
//
// `system_settings.uploads.sas_token_ttl_minutes` is the runtime knob,
// but we clamp it to a sane range here so a misconfigured admin can't
// mint 30-day SAS tokens (which would defeat the point of using SAS at
// all).

// Floor is 5 min so the SAS lifetime stays comfortably above the
// 30-second clock-skew floor used at signing time (see
// `utils/azure-blob.ts:SAS_START_SKEW_MS`). A floor of 1 min would mean a
// minted "1 min" SAS is actually valid for ~1.5 min — confusing for
// operators tightening the TTL.
export const ATTACHMENT_SAS_TTL_MIN_MINUTES = 5;
export const ATTACHMENT_SAS_TTL_MAX_MINUTES = 24 * 60; // 24 h
export const ATTACHMENT_SAS_TTL_DEFAULT_MINUTES = 15;

// ─── RBAC role sets ──────────────────────────────────────────────────────
//
// Like comments — route-level is "any project-access role". Per-row
// uploader/admin authorisation for delete is enforced inside the service.

export const ATTACHMENT_READ_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.CLIENT];
export const ATTACHMENT_WRITE_ROLES: readonly RoleType[] = ATTACHMENT_READ_ROLES;
