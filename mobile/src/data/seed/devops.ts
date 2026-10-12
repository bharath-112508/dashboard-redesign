import type { Deployment, DevopsProject, DevopsRequest } from '../types';

const NEXT_365 =
  'Once the required Microsoft 365 and Azure infrastructure details are received from the client, proceed with environment planning and infrastructure setup.';

/** v5's defaults for records owned by the development team. */
const DEV = { from: 'Development team', prio: 'Not set', act: 'Not required', updatedBy: 'Rahul' } as const;

const base: Pick<DevopsProject, 'overdue' | 'cicd' | 'logs' | 'notes'> = { overdue: false, cicd: false, logs: [], notes: [] };

/**
 * DevOps records (v5 `DV`, OPS-101…111). Project-specific (DECISIONS 3): each links to
 * a project by `projectId`; dates are ISO (A-14).
 */
export const DEVOPS: DevopsProject[] = [
  { ...base, key: 'OPS-101', projectId: 'dacop', infra: 'Not started', from: 'Not set', prio: 'Medium', act: 'Not required', phase: 'Kickoff email drafted. Onboarding starts once the client confirms the contact person.', deploy: 'Waiting', dev: 'Not set', owner: 'Chary', updatedBy: 'Rahul' },
  { ...base, key: 'OPS-102', projectId: 'inoffi', infra: 'Client onboarding', from: 'Client', prio: 'High', act: 'Reminder 1', step: 1, phase: 'Following up with the client for Azure environment onboarding.', logs: [{ by: 'Rahul', when: '2 d ago', text: 'First reminder sent asking for the Azure and Microsoft 365 tenant details.' }], actDate: '2026-10-05T07:00', reminder: '2026-10-12T07:00', initDue: '2026-11-30', deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', updatedBy: 'Rahul', next: NEXT_365 },
  { ...base, key: 'OPS-103', projectId: 'welop', infra: 'Client onboarding', from: 'Client', prio: 'Critical', act: 'Inform Marcus', step: 4, phase: 'Internal deployment is complete. Follow up with the client regarding the previously sent email and await their response.', logs: [{ by: 'Rahul', when: '3 d ago', text: 'No reply after the call. Marcus informed.' }], actDate: '2026-10-06T07:00', reminder: '2026-10-07T07:00', overdue: true, initDue: '2026-10-31', latestDue: '2026-11-20', moved: '+20 d', reason: 'No response from client', deploy: 'Waiting', dev: 'Not set', owner: 'Chary', updatedBy: 'Rahul' },
  { ...base, ...DEV, key: 'OPS-104', projectId: 'alncp', cicd: true, infra: 'Deployment Completed', from: 'DevOps', deploy: 'Completed', initDue: '2026-09-15', next: "Infrastructure changes will be implemented based on the development team's updates, and the environment will be prepared for deployment.", dev: 'Production', owner: 'Raj' },
  { ...base, ...DEV, key: 'OPS-105', projectId: 'alnla', cicd: true, infra: 'Adding new services', prio: 'Medium', deploy: 'Completed', initDue: '2026-12-15', ifu: [{ date: '2026-10-02', name: 'Waiting for dev team', done: true, note: 'Asked dev team for the new service list.' }, { date: '2026-10-14', name: 'Follow-up 1' }], reminder: '2026-10-14T07:00', next: 'Review the upcoming feature requirements once received from the development team and implement any necessary infrastructure changes.', dev: 'Development', owner: 'Raj' },
  { ...base, ...DEV, key: 'OPS-106', projectId: 'arcf', cicd: true, infra: 'Prod product deployment', prio: 'High', deploy: 'Waiting', initDue: '2026-10-30', ifu: [{ date: '2026-10-08', name: 'Waiting for dev team' }], reminder: '2026-10-08T07:00', overdue: true, next: 'Waiting for the Developers Update. Any necessary changes will be implemented based on the feedback received.', dev: 'Client validation', owner: 'Ganesh' },
  { ...base, ...DEV, key: 'OPS-107', projectId: 'fatw', infra: 'Dev project deployment', from: 'DevOps', prio: 'Low', deploy: 'Waiting', initDue: '2026-11-15', next: 'The VM is ready as per the requirement and will be changed according to the next phase of development.', dev: 'Development', owner: 'Ganesh' },
  { ...base, ...DEV, key: 'OPS-108', projectId: 'osbyw', infra: 'Internally deployment', prio: 'Medium', deploy: 'Waiting', initDue: '2026-11-20', ifu: [{ date: '2026-09-25', name: 'Waiting for dev team', done: true, note: 'Dev team still finishing the API.' }, { date: '2026-10-02', name: 'Follow-up 1', done: true, note: 'Two more days needed for testing.' }, { date: '2026-10-16', name: 'Follow-up 2' }], reminder: '2026-10-16T07:00', next: 'Waiting for the development team to complete the project. Infrastructure changes will be initiated if required.', dev: 'Testing', owner: 'Ganesh' },
  { ...base, key: 'OPS-109', projectId: 'redbp', infra: 'Client onboarding', from: 'Client', prio: 'Medium', act: 'Waiting for client', step: 0, phase: 'Onboarding email sent with the infrastructure checklist.', logs: [{ by: 'Rahul', when: 'Today', text: 'Onboarding started and checklist sent to the client.' }], actDate: '2026-10-09T07:00', reminder: '2026-10-12T07:00', initDue: '2026-12-15', deploy: 'Waiting', dev: 'Not set', owner: 'Vivek', updatedBy: 'Rahul' },
  { ...base, ...DEV, key: 'OPS-110', projectId: 'sstmp', infra: 'Not started', from: 'Not set', deploy: 'Waiting', dev: 'Not set', owner: 'Unassigned' },
  { ...base, ...DEV, key: 'OPS-111', projectId: 'trca', cicd: true, infra: 'Deployment Completed', from: 'DevOps', deploy: 'Completed', initDue: '2026-09-01', next: "Infrastructure changes will follow the client's requirements as future development phases progress.", dev: 'Production', owner: 'Rahul' },
];

/** Deployments reported by CI/CD (static; v5 `DEPLOYS`, only OPS-106). */
export const DEPLOYS: Record<string, Deployment[]> = {
  'OPS-106': [
    { v: '2.6.1', name: 'Ticket import and BankID login', st: 'Live', when: 'Today, 10:20' },
    { v: '2.6.0', name: 'Push notifications', st: 'Live', when: '9 Oct, 13:12' },
    { v: '2.5.3', name: 'Profile settings', st: 'Rolled back', when: '8 Oct, 16:40', note: 'Rolled back to 2.5.2' },
    { v: '2.5.2', name: 'Performance fixes', st: 'Live', when: '6 Oct, 10:05' },
    { v: '1.0.0', name: 'First go-live', st: 'Live', when: '28 Sep, 09:00' },
  ],
};

/** DevOps requests (v5 `REQ0`); the project name comes from the DevOps record. */
export const DEVOPS_REQUESTS: DevopsRequest[] = [
  { id: 1, key: 'OPS-102', rkey: 'REQ-12', type: 'Environment', prio: 'High', to: 'Vivek', text: 'Staging environment for the intranet', by: 'Chary', when: '2 days ago', status: 'Open', comments: [] },
  { id: 2, key: 'OPS-103', rkey: 'REQ-14', type: 'Security', prio: 'High', to: 'Chary', text: 'SSL certificate for portal domain', by: 'Vivek', when: 'yesterday', status: 'Open', comments: [] },
  { id: 3, key: 'OPS-106', rkey: 'REQ-9', type: 'Deployment', prio: 'Medium', to: 'Ganesh', text: 'Deploy 2.6.2 to production after client validation', by: 'Rahul', when: 'today', status: 'Open', comments: [{ who: 'Ganesh', t: 'Scheduled for Monday 07:00.', when: '1h ago' }] },
  { id: 4, key: 'OPS-108', rkey: 'REQ-15', type: 'Configuration', prio: 'Low', to: 'Ganesh', text: 'Log retention to 30 days', by: 'Bhavana P', when: '3 days ago', status: 'Done', comments: [] },
];
