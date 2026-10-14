/**
 * Tests only: the `GET /board` answer built from a table of the per-project reads, as the
 * backend builds it from the same routes' services (live projects that can be read).
 */
export const boardFromRoutes = (routes: Record<string, unknown>) =>
  ((routes['/projects?limit=100&page=1'] ?? []) as { id: string; is_archived?: boolean }[])
    .filter(p => !p.is_archived && `/projects/${p.id}/members` in routes)
    .map(p => ({
      project: p,
      stories: routes[`/projects/${p.id}/stories?limit=100&page=1`],
      sprints: routes[`/projects/${p.id}/sprints?limit=100&page=1`],
      statuses: routes[`/projects/${p.id}/custom-statuses`],
      members: routes[`/projects/${p.id}/members`],
      tasks: routes[`/tasks?project_id=${p.id}&limit=100&page=1`],
    }))
