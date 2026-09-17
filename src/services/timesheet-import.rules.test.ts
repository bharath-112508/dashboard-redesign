import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Import rules vs single-entry rules — the DRIFT guard.
 *
 * The design doc proposed routing the commit through `createEntry` so import
 * would reuse the real create path. That does not survive contact with the
 * preview: a dry run must not write, so `validateImportRows` has to carry the
 * rules itself, and routing the commit through `createEntry` too would mean
 * two copies validating the same rows.
 *
 * So the rules live in ONE place — and this file is the price of that. It
 * asserts, structurally, that every guard `createEntry` applies has a
 * counterpart in `validateImportRows`. If someone adds a rule to the
 * single-entry path and not to import, this fails and names the rule.
 *
 * A structural check, not a behavioural one: it reads both sources. That is
 * deliberately blunt, and blunt is the point — a behavioural equivalence test
 * would need a live database and would be skipped the moment it got slow.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(join(here, f), 'utf8');

const timesheetSvc = read('timesheet.service.ts');
const importSvc = read('timesheet-import.service.ts');

/** The guards `createEntry` runs, and what import must do about each. */
const GUARDS: Array<{ name: string; inCreateEntry: RegExp; inImport: RegExp; why: string }> = [
    {
        name: 'no future dates',
        inCreateEntry: /assertNotFuture\(/,
        inImport: /r\.date > today/,
        why: 'a sheet filled in ahead of time would log hours that have not happened',
    },
    {
        name: 'non-zero duration',
        inCreateEntry: /assertNonZero\(/,
        inImport: /total === 0/,
        why: 'a row with no hours is almost always an unfinished line, not an intent to log nothing',
    },
    {
        name: 'entry under the per-entry cap',
        inCreateEntry: /assertEntryUnderDailyCap\(/,
        inImport: /TIMESHEET_HOURS_MAX \* 60/,
        why: 'a mistyped 80 in an hours cell should be refused, not persisted',
    },
    {
        name: 'project visible to the caller',
        inCreateEntry: /loadProjectForCaller\(/,
        inImport: /buildProjectVisibilityFilter\(/,
        why: 'THE authorization boundary — typing a code must not reach a project the caller cannot open',
    },
    {
        name: 'a project-less general entry carries a managed category',
        inCreateEntry: /isGeneralCategoryValid\(/,
        inImport: /canonicalGeneralCategory\(/,
        why:
            'without a project the category is the only thing attributing the hour, so free text ' +
            'there cannot be grouped or charted — and this is the rule that caught the list out: ' +
            'the single-entry path moved to "a project OR a category" while import still demanded ' +
            'a project on every row, and every test here passed throughout',
    },
    {
        name: 'task belongs to the named project',
        inCreateEntry: /does not match the parent project of task_id|loadTaskForCaller\(/,
        inImport: /is not on \$\{label\}|taskByKey\.get\(/,
        why: 'otherwise hours land on the wrong project while the sheet says the right one',
    },
];

describe('import rules track single-entry rules', () => {
    for (const g of GUARDS) {
        it(`${g.name} — ${g.why}`, () => {
            expect(
                g.inCreateEntry.test(timesheetSvc),
                `createEntry no longer applies "${g.name}" the way this test recognises it. ` +
                    'Either the guard moved (update the pattern) or it was removed (check that was intended).'
            ).toBe(true);

            expect(
                g.inImport.test(importSvc),
                `validateImportRows is missing "${g.name}". createEntry enforces it, so a bulk import ` +
                    `would accept rows the single-entry path refuses — ${g.why}.`
            ).toBe(true);
        });
    }

    it('import does not demand a project on every row', () => {
        // The inverse of the guard above, and the one a structural checklist
        // cannot express as a pattern: this is about the ABSENCE of a rule.
        // `resolveProject` must be reached conditionally, or internal time —
        // meetings, training, support — cannot be imported at all.
        expect(importSvc).toMatch(/if \(projectCell\) \{[\s\S]{0,200}resolveProject\(/);
    });

    it('the commit does not trust the preview', () => {
        // The commit must re-run validation. If it ever starts accepting a
        // caller-supplied "already validated" flag, a client could post rows
        // the preview never saw.
        expect(importSvc).toMatch(/commitImport[\s\S]*validateImportRows\(rows, caller\)/);
    });

    it('the commit is all-or-nothing', () => {
        expect(importSvc).toMatch(/commitImport[\s\S]*withTransaction/);
        // A blocked row must abort BEFORE any write.
        expect(importSvc).toMatch(/blocked\.length > 0[\s\S]*throw AppError/);
    });
});
