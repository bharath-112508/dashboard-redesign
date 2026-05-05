/**
 * Report-subscription constants (Phase 4 Step 43 —
 * `/report-subscriptions/*` + daily cron sweep).
 *
 * A subscription is a saved report query plus a weekly schedule.
 * The cron picks up active subscriptions whose `day_of_week` matches
 * today (IST) and sends the rendered report inline (HTML body — no
 * attachments in v1; the existing mailer is a stub that needs ACS
 * wiring per Build_Decisions §D1, and adding attachment support has
 * its own blast radius).
 *
 * Owner-scoped: each subscription belongs to one user; nobody else
 * sees it (not even admins reading another admin's subscriptions —
 * same posture as notifications + refresh-token sessions + Step-42
 * presets).
 */

import { ROLES, type RoleType } from './roles.js';

// ─── RBAC ───────────────────────────────────────────────────────────────
//
// Mirrors Step-29 + Step-42 — admin + manager only. A subscription's
// value is gated by the report's role: an employee can't run the
// billing report, so they have nothing to subscribe to.

export const REPORT_SUBSCRIPTION_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER];

// ─── Field caps ────────────────────────────────────────────────────────

export const REPORT_SUBSCRIPTION_NAME_MAX = 100;

// ─── Per-user cap ──────────────────────────────────────────────────────
//
// Lower than the Step-42 preset cap (50) because each subscription
// also produces an outbound email per matching cron tick — a runaway
// 50-subscription user would generate 50 emails/week. 20 is
// comfortable headroom for "one per project + a few personal digests"
// without inviting abuse.

export const REPORT_SUBSCRIPTION_PER_USER_CAP = 20;

// ─── List endpoint pagination ──────────────────────────────────────────

export const REPORT_SUBSCRIPTION_LIST_DEFAULT_LIMIT = 20;
export const REPORT_SUBSCRIPTION_LIST_MAX_LIMIT = 100;

// ─── Weekly sweep cap ──────────────────────────────────────────────────
//
// One cron tick processes at most this many subscriptions. Bounds wall
// time + outbound-email rate per tick. With per-user cap = 20 and an
// org of ~50 active managers all subscribed to a Monday digest, peak
// concurrent sends could touch this; 500 is a comfortable ceiling.

export const REPORT_SUBSCRIPTION_MAX_PER_RUN = 500;

// ─── Schedule fields ───────────────────────────────────────────────────

/** 0=Sun..6=Sat. Stored on the model as a single integer. */
export const REPORT_SUBSCRIPTION_MIN_DAY_OF_WEEK = 0;
export const REPORT_SUBSCRIPTION_MAX_DAY_OF_WEEK = 6;

// Hour-local is 0-23 IST. **Stored for forward-compat; NOT consumed
// by the v1 cron**, which fires once daily at 07:00 IST and emails
// every active subscription whose `day_of_week` matches today,
// regardless of `hour_local`. The field exists so the FE can offer a
// "send at" picker today and keep its UX stable when a future Phase-5
// hourly-cron variant honours the hour. Existing rows already carry
// the configured hour at that point — no migration needed.
//
// Honest summary: setting `hour_local: 17` does NOT delay your Monday
// email to 5 PM in v1. It still arrives at 07:00 IST. The cron sweep
// service does NOT filter on this field.
export const REPORT_SUBSCRIPTION_MIN_HOUR_LOCAL = 0;
export const REPORT_SUBSCRIPTION_MAX_HOUR_LOCAL = 23;
export const REPORT_SUBSCRIPTION_DEFAULT_HOUR_LOCAL = 7;

// ─── Email shape ───────────────────────────────────────────────────────

/** Top-K rows shown in the inline summary; the rest are hinted at via "and N more". */
export const REPORT_SUBSCRIPTION_PREVIEW_ROW_LIMIT = 10;
