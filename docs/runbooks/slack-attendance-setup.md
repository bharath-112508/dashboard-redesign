# Slack Attendance — App Setup

Enables the App Home check-in/out tab and the daily nudge buttons. The code
ships dark (`slack.attendance_nudges.enabled = false`); follow these steps to
turn it on.

## 1. Slack app config (api.slack.com → your app)

- **OAuth & Permissions → Bot Token Scopes** — add: `chat:write`, `im:write`,
  `users:read.email` (in addition to the existing `commands`, `users:read`).
  Reinstall the app to the workspace after adding scopes.
- **App Home** — enable the **Home Tab**.
- **Event Subscriptions** — enable; set the Request URL to
  `https://<host>/api/v1/slack/events`. Slack will POST a `url_verification`
  challenge; the endpoint echoes it, so verification succeeds once the server
  is reachable. Under **Subscribe to bot events**, add `app_home_opened`.
  Reinstall if prompted.
- **Interactivity & Shortcuts** — already enabled (leave approve/reject). No
  change needed; the new buttons post to the existing interactive URL.

## 2. Platform settings

- `PATCH /settings/slack` with a valid `bot_token` and `enabled: true`.
- Turn nudges on and (optionally) set times:
  `PATCH /settings/slack { "attendance_nudges": { "enabled": true, "check_in_time": "11:00", "checkout_reminder_time": "20:00" } }`.
- Set `SLACK_SIGNING_SECRET` in the environment (required for all inbound
  Slack routes including `/events`).

## 3. Verify

- Open the bot in Slack → **Home** tab → confirm the Check In button renders;
  tap it and confirm the panel flips to Check Out.
- Trigger a nudge manually (in a Node REPL / one-off script):
  `import { runAttendanceCheckinNudge } from './dist/jobs/attendance-slack-nudge.job.js'; await runAttendanceCheckinNudge();`

## Notes

- Nudge fire-times are read at **scheduler boot**. Changing them in settings
  takes effect on the next process restart.
- Crons run only on the instance with `JOBS_ENABLED=true`.
- No geofence/WiFi handling — Slack check-ins are `method: 'manual'`.
