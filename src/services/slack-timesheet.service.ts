import type { Types } from 'mongoose';

import type { RoleType } from '../constants/roles.js';
import { Project } from '../models/project.model.js';
import { SLACK_SELECT_OPTION_CAP } from '../constants/slack.js';
import type { LogTimeProjectOption } from '../utils/slack-block-kit/timesheet.js';
import { buildProjectVisibilityFilter } from './project.service.js';

/**
 * Projects offerable in the Slack "Log time" modal.
 *
 * Scoped with `buildProjectVisibilityFilter` — the same helper every other
 * project read uses — so an Employee sees exactly the projects the web picker
 * shows them and there is no second copy of the visibility rule to drift.
 *
 * Capped at Slack's `static_select` ceiling: 101 options is an API error, not
 * a truncated menu, so the limit is enforced in the query rather than left to
 * the builder to trip over.
 */
export const loadLogTimeProjects = async (caller: {
    id: Types.ObjectId;
    role: RoleType;
}): Promise<LogTimeProjectOption[]> => {
    const rows = await Project.find({
        ...buildProjectVisibilityFilter(caller),
        is_archived: false,
    })
        .sort({ name: 1 })
        .limit(SLACK_SELECT_OPTION_CAP)
        .lean();

    return rows.map((p) => ({
        id: String((p as { _id: Types.ObjectId })._id),
        label: (p as { name: string }).name,
    }));
};
