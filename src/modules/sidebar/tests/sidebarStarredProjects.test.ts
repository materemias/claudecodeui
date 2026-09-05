import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, StarredSessionListItem } from '@/shared/types';
import { buildStarredProjects } from '@/modules/sidebar/hooks/useSidebarController';

/**
 * The starred-sessions filter cannot be a filter over `project.sessions`: the
 * sidebar loads one page of sessions per project, and a star usually points at
 * an older session that page does not contain. buildStarredProjects therefore
 * grafts the starred rows onto their project, which is what these tests pin.
 */

const makeProject = (projectId: string, sessionIds: string[]): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/tmp/${projectId}`,
  sessions: sessionIds.map((id) => ({
    id,
    summary: `loaded ${id}`,
    lastActivity: '2026-08-21T10:00:00.000Z',
  })),
  sessionMeta: { total: 40, hasMore: true, nextOffset: sessionIds.length },
}) as unknown as Project;

const makeStarredSession = (
  sessionId: string,
  projectId: string | null,
  overrides: Partial<StarredSessionListItem> = {},
): StarredSessionListItem => ({
  sessionId,
  provider: 'claude',
  projectId,
  projectPath: projectId ? `/tmp/${projectId}` : null,
  projectDisplayName: projectId ?? 'unknown',
  sessionTitle: `starred ${sessionId}`,
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-21T09:00:00.000Z',
  lastActivity: '2026-08-21T09:00:00.000Z',
  isArchived: false,
  isProjectArchived: false,
  isOneShot: false,
  ...overrides,
});

test('a starred session beyond the loaded page is grafted onto its project', () => {
  const project = makeProject('paged-project', ['loaded-1', 'loaded-2']);
  const starredSessions = [
    makeStarredSession('loaded-2', 'paged-project'),
    makeStarredSession('unpaged-session', 'paged-project'),
  ];

  const starredProjects = buildStarredProjects([project], starredSessions, 'name');

  assert.equal(starredProjects.length, 1);
  assert.deepEqual(
    starredProjects[0]?.sessions?.map((session) => session.id),
    ['loaded-2', 'unpaged-session'],
  );
  // The loaded row wins for a session present in both: it carries the richer
  // metadata the session row renders.
  assert.equal(starredProjects[0]?.sessions?.[0]?.summary, 'loaded loaded-2');
  assert.equal(starredProjects[0]?.sessions?.[1]?.summary, 'starred unpaged-session');
  // Pagination is closed off: the view already holds every starred session.
  assert.equal(starredProjects[0]?.sessionMeta?.total, 2);
  assert.equal(starredProjects[0]?.sessionMeta?.hasMore, false);
});

test('projects without a starred session are dropped', () => {
  const starredProject = makeProject('starred-project', ['starred-1']);
  const plainProject = makeProject('plain-project', ['plain-1']);

  const starredProjects = buildStarredProjects(
    [starredProject, plainProject],
    [makeStarredSession('starred-1', 'starred-project')],
    'name',
  );

  assert.deepEqual(starredProjects.map((project) => project.projectId), ['starred-project']);
});

test('archived, project-archived and orphaned starred sessions are excluded', () => {
  const project = makeProject('mixed-project', ['visible', 'archived-session', 'orphan']);
  const starredSessions = [
    makeStarredSession('visible', 'mixed-project'),
    makeStarredSession('archived-session', 'mixed-project', { isArchived: true }),
    makeStarredSession('project-archived-session', 'mixed-project', { isProjectArchived: true }),
    makeStarredSession('orphan', null),
  ];

  const starredProjects = buildStarredProjects([project], starredSessions, 'name');

  assert.deepEqual(
    starredProjects[0]?.sessions?.map((session) => session.id),
    ['visible'],
  );
});

test('a project whose only starred sessions are archived is dropped entirely', () => {
  const project = makeProject('archived-only', ['archived-session']);

  const starredProjects = buildStarredProjects(
    [project],
    [makeStarredSession('archived-session', 'archived-only', { isArchived: true })],
    'name',
  );

  assert.deepEqual(starredProjects, []);
});
