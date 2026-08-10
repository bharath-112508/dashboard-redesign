# Demo data preparation

Scripts that reduce a working database to a clean, believable demo dataset:
two client companies with one populated project each, and internally
consistent attendance / timesheets / activity.

**Every script is dry-run by default. `--commit` writes.** All of them call
`assertSafeDb`, so they refuse to run against any database not named in
`SAFE_DB_NAMES` (`scripts/_safe-db.ts`). Widen that list deliberately — every
name in it is a database somebody is allowed to destroy.

**Back up first.** `demo-prune` deletes hundreds of rows across ~30
collections:

```bash
mongodump --uri="$MONGO_URI" --out=~/demo-backup-$(date +%Y%m%d-%H%M%S)
# restore: mongorestore --drop --uri="$MONGO_URI" <dir>/<dbname>
```

## Order matters

Later scripts assume earlier ones have run. Run them in this order:

| # | Script | What it does | Destructive |
|---|---|---|---|
| 1 | `demo-prune` | Keeps only the companies in `KEEP_COMPANY_NAMES` and projects in `KEEP_PROJECT_CODES`; deletes everything hanging off the rest, plus client-side users of deleted companies and named junk accounts | **yes** |
| 2 | `demo-humanize` | Trims placeholder contacts, fixes names/emails, shifts the timeline forward, gives idle staff work, spreads task authorship off admin | **yes** |
| 3 | `demo-polish` | Replaces gibberish free text ("te5y6t") with text that fits its row | no |
| 4 | `demo-descriptions` | Real task descriptions; realigns activity actors with `created_by` | no |
| 5 | `demo-comments` | Seeds discussion threads on in-flight tasks | no |
| 6 | `demo-attendance` | Marks people present on working days — the finalizer cron marks everyone absent on a DB nobody checks into | no |
| 7 | `demo-fill-recent` | One logged day per person per day they were present; re-dates activity; moves work off holidays | no |
| 8 | `demo-fix-hours` | Spreads any day over 10h across the calendar. Moves only — never deletes or shortens | no |

Read-only helpers, safe any time:

- `demo-survey` — companies, projects, row counts, users by role
- `demo-verify` — walks the FK graph, reports references that no longer resolve
- `demo-coverage` — per-day attendance vs timesheets vs activity, flags thin days

## Before each demo

Steps 6–8 fill data **up to the day they run**. If the demo is on a later date,
re-run them that morning or the newest days will be empty and the dashboard
will read "0 of 15 present":

```bash
npx tsx scripts/demo-attendance.ts --commit
npx tsx scripts/demo-fill-recent.ts --commit
npx tsx scripts/demo-fix-hours.ts --commit
npx tsx scripts/demo-coverage.ts      # confirm every working day is filled
npx tsx scripts/demo-verify.ts        # confirm nothing dangles
```

## Notes

- **`demo-humanize`'s date shift is guarded.** It is the one non-idempotent
  step: running it twice would push everything another fortnight and leave the
  demo two weeks in the future. It skips itself when the newest timesheet is
  already within a week of today.
- **Attachments are never seeded.** A `task_attachments` row is only a pointer
  to an Azure blob; a fabricated row is a download button that 404s in front of
  an audience. Upload one by hand if you need to show the feature.
- **`audit_logs` is left alone.** An audit trail with holes is worse than one
  mentioning things that no longer exist, and the log view renders text, not
  links.
- **Attendance rows with status `weekend`, `holiday` or `on_leave` are never
  overwritten** — `on_leave` mirrors a real approved leave request, so changing
  it would contradict the Leaves screen.
