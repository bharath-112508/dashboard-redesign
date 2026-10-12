import { NOTIFICATIONS } from '../seed/notifications';
import type { AppState } from '../store/state';
import type { AppNotification, Role } from '../types';
import { myRole } from './session';

/** The feed a role sees (client feed for clients; staff feed without hidden items). */
export function notificationsFor(role: Role): AppNotification[] {
  const feed = role === 'client' ? 'client' : 'staff';
  return NOTIFICATIONS.filter((n) => n.feed === feed && !n.hideFor?.includes(role));
}

export interface NotificationRow extends AppNotification {
  unread: boolean;
}

/** The signed-in person's notifications with read state. */
export function notifications(s: AppState): NotificationRow[] {
  const role = myRole(s);
  if (!role) return [];
  return notificationsFor(role).map((n) => ({ ...n, unread: !s.read[n.id] }));
}

export function unreadCount(s: AppState): number {
  return notifications(s).filter((n) => n.unread).length;
}
