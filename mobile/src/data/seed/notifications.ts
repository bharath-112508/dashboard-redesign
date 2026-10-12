import type { AppNotification } from '../types';

/** Notification feeds (prototype NB, SPEC S-INBOX). Static; read state is in the store. */
export const NOTIFICATIONS: AppNotification[] = [
  // Staff feed
  {
    id: 'd1', feed: 'staff', icon: 'rocket', tone: { bg: '#D6E9E2', fg: '#195040' },
    text: 'Daco platform 2.6.2 is live · Bug fixes for ticket import', when: 'Just now',
    target: { kind: 'devops', project: 'Daco platform' },
  },
  {
    id: 's1', feed: 'staff', icon: 'message-square-text', tone: { bg: '#DCE5FA', fg: '#1F3FAF' },
    text: 'Chary commented on PMT-11', when: '12 min ago', target: { kind: 'ticket', id: 1 },
  },
  {
    id: 's2', feed: 'staff', icon: 'arrow-right-left', tone: { bg: '#E6DFFA', fg: '#3F2E94' },
    text: 'Vivek moved DIN-5 to Review', when: '1h ago', target: { kind: 'ticket', id: 3 },
  },
  {
    id: 's3', feed: 'staff', icon: 'user-plus', tone: { bg: '#D6E9E2', fg: '#195040' },
    text: 'You were assigned NRD-9 · Critical', when: '3h ago', target: { kind: 'ticket', id: 5 },
  },
  {
    id: 's4', feed: 'staff', icon: 'triangle-alert', tone: { bg: '#FBE7E3', fg: '#C0392B' },
    text: 'PMT-20 is 1 day overdue', when: 'Today 07:00', target: { kind: 'ticket', id: 2 },
  },
  {
    id: 's5', feed: 'staff', icon: 'circle-check', tone: { bg: '#D6E9E2', fg: '#195040' },
    text: 'Your leave for 24–25 Oct was approved', when: 'Yesterday', target: { kind: 'leave' }, hideFor: ['free'],
  },
  // Client feed
  {
    id: 'c1', feed: 'client', icon: 'message-circle-question', tone: { bg: '#FBE7E3', fg: '#C0392B' },
    text: 'Rahul asked: Which languages at launch?', when: '2 days ago', target: { kind: 'question', id: 1 },
  },
  {
    id: 'c2', feed: 'client', icon: 'message-square-text', tone: { bg: '#DCE5FA', fg: '#1F3FAF' },
    text: 'Chary replied twice on Logo files for the app icon', when: '1h ago', target: { kind: 'question', id: 2 },
  },
  {
    id: 'c3', feed: 'client', icon: 'bug', tone: { bg: '#F6DDD0', fg: '#7A3818' },
    text: 'Chary replied on your bug PMT-34', when: '3h ago', target: { kind: 'ticket', id: 9 },
  },
  {
    id: 'c4', feed: 'client', icon: 'folder-kanban', tone: { bg: '#D6E9E2', fg: '#195040' },
    text: 'Sprint 2 of Mobile app ends in 8 days', when: 'Today 07:00', target: { kind: 'project', name: 'Daco platform' },
  },
];
