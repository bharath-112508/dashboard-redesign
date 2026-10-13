# Filter placement guidance

_Started 2026-10-09 17:06 UTC_

---

## User

keep filters beside the headings

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

I moved the filter tabs up so they sit next to the "Projects" heading, between it and the New project button. Board/List and Search stay in the row below.

If you meant filters next to each column heading in the list table, tell me and I'll do that instead.

## User

o revert back, and i mean beside project with acending and decending oderer symbol

## Assistant

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: grep]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

The filter tabs are back below the heading. In the list view, the "Project" column heading now has an up/down arrow. Click it to sort A→Z, again for Z→A, and a third time to go back to the original order. The arrow for the current direction turns dark.

## User

but for all titles

## Assistant

_[tool: read_file]_

_[tool: grep]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Every column heading in the list view now has a sort arrow. Clicking a heading sorts ascending, a second click sorts descending, and a third goes back to the original order. Only one column sorts at a time.

- **Status and Priority** sort in their workflow order (Critical → Low for priority), not alphabetically.
- **Date columns** sort by date.
- **Rows with no value** always go to the bottom, in either direction.

A background check is still running on the change.

## User

and here another thing only when action is from cliet the follow up sequcese should work, when for developer, it should ask after the first date, they should ask when will the next date be... so you undertand following up internally and externally is diffrent. 

and i should only add date when i move status to client onboarding, not wherni create the proejct.

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

Follow-ups now work differently for client and internal projects:

- **Client:** the fixed reminder sequence only shows when the action is from the client and the status is past "Not started". For "Not started" client projects, the follow-up tab says the sequence begins at Client onboarding.
- **Moving to Client onboarding:** the status change box now asks for the follow-up start date and won't save without it. All the reminder dates in the sequence are worked out from that date.
- **Developer / DevOps:** there's no fixed sequence. You set the first follow-up date, and each time you log a follow-up you write what they said and pick the next date. That next date becomes the project's reminder.
- **Changing the action owner:** if a project switches away from the client, its client sequence is cleared.

I made two assumptions, so check them:

1. The date you meant was the client follow-up start date, not the estimated deployment date.
2. The New project button doesn't open a form yet, so creating a project doesn't ask for any date today. I can build that form without a date field if you want it.

A background check is still running on these changes.

## User

Found issues — fixing…

## Assistant

_[tool: grep]_

_[tool: dc_html_str_replace]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

I fixed a message that contradicted the new follow-ups. The old "No follow-ups running" note was still showing under internal follow-ups and on client projects waiting for onboarding. Now it only appears when neither of those applies. I didn't re-run the background check on this fix.

## User

so there should be two follow secqes one for client and onr for dev

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

There are now two follow-up sequences, with a Client / Internal switch at the top of each project's follow-up tab.

- **The switch:** it opens on the sequence the project is using, which has an "In use" badge. The other tab shows that sequence's steps greyed out, with a note on when it would apply.
- **Client sequence:** works as before, on a fixed schedule that begins when the status moves to Client onboarding.
- **Internal sequence (dev team or DevOps):** the steps are Waiting for dev team → Follow-up 1 → Follow-up 2 → Inform team lead → Escalate. There are no fixed day gaps. You pick the date for each step when you move to it, and the board and list show which step a project is on.
- **Settings:** the "Follow-up sequences" tab now lets you edit both sequences. The internal one has no day offsets.

A background check is still running on these changes.

_[tool: run_script]_

_[tool: ready_for_verification]_

Moving a project to Client onboarding now asks for two dates:

- **Initial due date:** saved as the project's fixed initial due date.
- **First reminder:** saved as the next reminder. "Waiting for client" starts today, and the later steps are spaced out from the first reminder using the client sequence's day gaps.

Save stays disabled until both dates are filled in. If the project already has an initial due date, it's filled in for you. A background check is still running.

## User

now this is good, what i want you to do is make thsis section good as well

## User

now this is good, what i want you to do is make thsis section good as well

## User

Found issues — fixing…

## Assistant

_[tool: run_script]_

_[tool: ready_for_verification]_

I fixed the mismatched counts. The "waiting on client" number under the title now matches the Waiting on client filter. "Waiting on dev team" now counts every project where the action is from the development team or DevOps, not just ones with an internal sequence started.

## User

no thi s is still boring, make it something super

## Assistant

_[tool: read_file]_

_[tool: run_script]_

_[tool: grep]_

_[tool: dc_html_str_replace]_

_[tool: ready_for_verification]_

I redesigned the header:

- **Top row:** today's date sits above a larger "Projects" title. Search, the Board/List switch and New project now share one row on the right.
- **Filter tiles:** the filters are now six tiles, each with a big count, the filter name and a short line saying what it covers. Each tile has its own colour stripe, and clicking one selects it, filling it dark.
- **Due now:** the count turns red when anything is overdue, and the tile fills red when selected.
- **Removed:** the summary line under the title, since the tiles show the same numbers.

A background check is still running.

_[tool: run_script]_

_[tool: ready_for_verification]_

The header is back to the earlier version: the summary line under the title, the pill filters, and Board/List and Search on the right. The check's comments were about the tiles, which are now gone, so there's nothing left to fix.

## User

and in not started, when no date is secled in both list and board, view inside the tikets i want to see added date.

## Assistant

_[tool: run_script]_

_[tool: grep]_

_[tool: run_script]_

_[tool: ready_for_verification]_

"Not started" projects with no due date now show their added date, for example "Added 04 Oct". In the list it goes in the Est. deployment column with "x days ago" underneath. On the board it goes in the card's date spot. Projects in any other status are unchanged.

Every project's activity now starts with a "Project added" entry showing the date.

Two things to check:
- The added dates are made-up sample dates.
- I removed the due dates from the two "Not started" sample projects (DACO, Inoff). That's because dates are now only set when a project moves to Client onboarding.

A background check is still running.

## User

in list view i want the added on text in the pfollow up not at est deployemnt

## Assistant

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

In the list view, "Not started" projects now show "Added 04 Oct" with "x days ago" in the Follow-up column. Their Est. deployment column shows "—". The board cards still show the added date as before. A background check is still running.

## User

and once do entire check of tickets now you habe not started and stull getting next reminder, keep diiffrent staus for difrent tickets so you can know what is what

## Assistant

_[tool: read_file]_

_[tool: run_script]_

_[tool: ready_for_verification]_

I went through every ticket and rebuilt the sample data so each status behaves the way it should. Today is 9 Oct, so "overdue" below means the reminder date has passed.

- **Not started (DACO, SST):** no reminder, no follow-up sequence and no due dates. They only show their added date. The board now strips these from any "Not started" project automatically.
- **Client onboarding (Inoff, Weland, Redare):**
  - Redare has just started at "Waiting for client".
  - Inoff is on Reminder 1, due 12 Oct.
  - Weland is Critical, escalated at "Inform Marcus", overdue, with its due date moved 20 days later.
- **Waiting on the dev team (internal sequence):**
  - ARC Fast is at the first step and overdue.
  - Alnarp Lead Automation is on Follow-up 1, due 14 Oct.
  - OSBY is on Follow-up 2, due 16 Oct.
- **DevOps owns it, no follow-up:** Fa tech, in Dev project deployment.
- **Deployment Completed (Alnarp Customer portal, Tryggrätt):** no reminders.

That gives a clear spread across all seven statuses and every filter. The names, owners and descriptions are kept from the old data, but the dates and follow-up steps are made up. A background check is still running.

## User

Found issues — fixing…

## Assistant

_[tool: run_script]_

_[tool: ready_for_verification]_

I fixed the "Waiting on dev team" count. It was counting completed projects and DevOps-owned ones like Fa tech. It now only counts projects where the action is from the development team and that aren't Not started or Deployment Completed: Alnarp Lead Automation, ARC Fast and OSBY. I skipped the background re-check for this small fix.

## User

when i oprn ticket i need to seee first tab not second

## Assistant

_[tool: grep]_

_[tool: grep]_

_[tool: dc_js_str_replace]_

_[tool: ready_for_verification]_

Opening any ticket now lands on the first tab, Follow-ups. Before, tickets without a client sequence opened on Phases.

## User

in plac eof unassigned, in dev pahse owner, have next step and when pressed say set date and owner.

## User

in plac eof unassigned, in dev pahse owner, have next step and when pressed say set date and owner.

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

On the Phases tab, a ticket with no dev phase owner now shows a "Next step →" button where "Unassigned" used to be. Pressing it opens a "Set date and owner" form:

- **Title:** filled in with the next dev phase name, and you can edit it.
- **Owner:** pick one of the dev team people.
- **Due date:** saved as the dev phase due date.

Save stays disabled until all three are filled. Saving sets the owner and due date and adds the step to Activity. After that, the card shows the owner picker as before. A background check is still running.

## User

Found issues — fixing…

## User

in the details have CI/CD like a toggle

## User

in the details have CI/CD like a toggle

## Assistant

_[tool: grep]_

_[tool: read_file]_

_[tool: run_script]_

_[tool: ready_for_verification]_

The ticket Details panel now starts with a CI/CD toggle. It reads "Pipeline set up" when on (green) and "No pipeline" when off. Each switch is recorded in Activity.

I turned it on by default for four sample projects: Alnarp Customer portal, Alnarp Lead Automation, ARC Fast and Tryggrätt.

## User

beside biard and list have another tab like internal and client which can be toggled

## User

Found issues — fixing…

## User

Found issues — fixing…

## Assistant

_[tool: run_script]_

_[tool: run_script]_

_[tool: ready_for_verification]_

The All / Client / Internal switch now sorts by project type, and all current projects are client projects. Internal is empty for now. The summary line under the title also matches the selected option.

There's no way yet to mark a project as internal. Should I add a "Project type" setting to the ticket details, or to a new-project form?

## User

have the cicd toggle below dev type

## Assistant

_[tool: run_script]_

_[tool: ready_for_verification]_

The CI/CD toggle now sits directly below the Deployment type row in Details. I took "dev type" to mean that field; tell me if you meant a different one.

