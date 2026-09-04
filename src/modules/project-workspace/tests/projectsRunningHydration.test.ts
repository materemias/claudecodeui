import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';
import { useProjectsState } from '@/modules/project-workspace/hooks/useProjectsState';

const projectsResponse = vi.fn();
const sessionDetailsResponse = vi.fn();
const projectSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: (sessionId: string) => sessionDetailsResponse(sessionId),
    projectSessions: (
      projectId: string,
      page: { limit: number; offset: number },
    ) => projectSessionsResponse(projectId, page),
  },
}));

const firstPageSessions = Array.from({ length: 20 }, (_, index) => ({
  id: `page-one-${index}`,
  summary: `Page one ${index}`,
  provider: 'claude' as const,
}));

const buildProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  path: '/repo/one',
  fullPath: '/repo/one',
  displayName: 'Project one',
  isStarred: false,
  sessions: firstPageSessions,
  sessionMeta: { total: 40, hasMore: true },
  ...overrides,
});

const projectResponse = (projects: Project[]) => ({
  ok: true,
  json: async () => projects,
});

const detailsResponse = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    data: {
      sessionId: 'later-session',
      provider: 'codex',
      summary: 'Hydrated row',
      createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T10:00:00.000Z',
      lastActivity: '2026-08-31T10:00:00.000Z',
      isArchived: false,
      project: {
        projectId: 'project-1',
        path: '/repo/one',
        fullPath: '/repo/one',
        displayName: 'Project one',
        isStarred: false,
        isArchived: false,
      },
      ...overrides,
    },
  }),
});

type ServerEventListener = (event: { kind: string }) => void;

const renderProjectsState = () => renderHook(() =>
  useProjectsState({
    sessionId: undefined,
    navigate: vi.fn(),
    subscribe: (_listener: ServerEventListener) => () => undefined,
    isMobile: false,
    isSessionProcessing: () => false,
  }),
);

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  sessionDetailsResponse.mockReset();
  projectSessionsResponse.mockReset();
  projectsResponse.mockResolvedValue(projectResponse([buildProject()]));
  sessionDetailsResponse.mockResolvedValue({ ok: false, status: 404 });
});

test('hydrates valid later-page rows once and ignores invalid siblings', async () => {
  sessionDetailsResponse.mockImplementation((sessionId: string) => {
    switch (sessionId) {
      case 'later-session':
        return Promise.resolve(detailsResponse());
      case 'other-project-session':
        return Promise.resolve(detailsResponse({
          sessionId,
          project: {
            projectId: 'project-2',
            path: '/repo/two',
            fullPath: '/repo/two',
            displayName: 'Project two',
            isStarred: true,
            isArchived: false,
          },
        }));
      case 'one-shot-session':
        return Promise.resolve(detailsResponse({ sessionId, isOneShot: true }));
      case 'invalid-provider':
        return Promise.resolve(detailsResponse({ sessionId, provider: 'invalid' }));
      case 'missing-project':
        return Promise.resolve(detailsResponse({ sessionId, project: null }));
      case 'archived-project':
        return Promise.resolve(detailsResponse({
          sessionId,
          project: {
            projectId: 'archived',
            path: '/repo/archived',
            fullPath: '/repo/archived',
            displayName: 'Archived',
            isArchived: true,
          },
        }));
      case 'stale-session':
        return Promise.resolve(detailsResponse({ sessionId, isArchived: true }));
      default:
        return Promise.resolve({ ok: false, status: 404 });
    }
  });

  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 20));

  const sourceIds = new Set([
    'later-session',
    'one-shot-session',
    'other-project-session',
    'invalid-provider',
    'missing-project',
    'archived-project',
    'stale-session',
  ]);
  await act(async () => {
    await result.current.hydrateRunningSessions(sourceIds);
  });

  const firstProject = result.current.projects.find((project) => project.projectId === 'project-1');
  const secondProject = result.current.projects.find((project) => project.projectId === 'project-2');
  assert.equal(firstProject?.sessions?.filter((session) => session.id === 'later-session').length, 1);
  assert.equal(firstProject?.sessionMeta?.nextOffset, 20);
  assert.equal(firstProject?.sessionMeta?.hasMore, true);
  assert.equal(
    firstProject?.sessions?.find((session) => session.id === 'one-shot-session')?.isOneShot,
    true,
  );
  assert.deepEqual(secondProject?.sessions?.map((session) => session.id), ['other-project-session']);
  assert.equal(secondProject?.sessionMeta?.nextOffset, 0);

  const allIds = result.current.projects.flatMap(
    (project) => (project.sessions ?? []).map((session) => session.id),
  );
  for (const ignoredId of ['invalid-provider', 'missing-project', 'archived-project', 'stale-session']) {
    assert.equal(allIds.includes(ignoredId), false);
  }

  projectsResponse.mockResolvedValueOnce(projectResponse([
    buildProject(),
    buildProject({
      projectId: 'project-2',
      path: '/repo/two',
      fullPath: '/repo/two',
      displayName: 'Project two',
      sessions: [],
      sessionMeta: { total: 1, hasMore: true },
    }),
  ]));
  await act(async () => {
    await result.current.handleSidebarRefresh();
  });
  assert.equal(
    result.current.projects.find((project) => project.projectId === 'project-2')?.__hydratedOnly,
    undefined,
  );

  projectsResponse.mockResolvedValueOnce(projectResponse([buildProject()]));
  await act(async () => {
    await result.current.handleSidebarRefresh();
  });
  assert.equal(
    result.current.projects.some((project) => project.projectId === 'project-2'),
    false,
  );
});

test('a pending project refresh merges rows hydrated while it is in flight', async () => {
  sessionDetailsResponse.mockResolvedValue(detailsResponse({ sessionId: 'during-refresh' }));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 20));

  let releaseRefresh: (() => void) | null = null;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  projectsResponse.mockImplementationOnce(async () => {
    await refreshGate;
    return projectResponse([buildProject({ displayName: 'Refreshed project' })]);
  });
  const refresh = result.current.handleSidebarRefresh();

  await act(async () => {
    await result.current.hydrateRunningSessions(new Set(['during-refresh']));
  });
  await act(async () => {
    releaseRefresh?.();
    await refresh;
  });

  const project = result.current.projects.find((candidate) => candidate.projectId === 'project-1');
  assert.equal(project?.displayName, 'Refreshed project');
  assert.equal(project?.sessions?.filter((session) => session.id === 'during-refresh').length, 1);
  assert.equal(project?.sessionMeta?.nextOffset, 20);
});

test('hydration does not advance the page cursor and a failed page leaves it unchanged', async () => {
  sessionDetailsResponse.mockResolvedValue(detailsResponse());
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 20));

  await act(async () => {
    await result.current.hydrateRunningSessions(new Set(['later-session']));
  });
  const hydratedProject = result.current.projects[0];
  assert.equal(hydratedProject.sessionMeta?.nextOffset, 20);
  assert.equal(hydratedProject.sessions?.length, 21);

  projectSessionsResponse.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ error: 'temporary failure' }),
  });
  let loadError: unknown = null;
  await act(async () => {
    try {
      await result.current.loadMoreProjectSessions('project-1');
    } catch (error) {
      loadError = error;
    }
  });
  assert.match(String(loadError), /temporary failure/);
  assert.equal(result.current.projects[0].sessionMeta?.nextOffset, 20);
  assert.equal(result.current.projects[0].sessions?.length, 21);

  const secondPageSessions = [
    { id: 'later-session', summary: 'Canonical row', provider: 'codex' as const },
    ...Array.from({ length: 19 }, (_, index) => ({
      id: `page-two-${index}`,
      summary: `Page two ${index}`,
      provider: 'claude' as const,
    })),
  ];
  projectSessionsResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      projectId: 'project-1',
      sessions: secondPageSessions,
      sessionMeta: { total: 40, hasMore: false },
    }),
  });
  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });

  assert.deepEqual(
    projectSessionsResponse.mock.calls.map(([, page]) => page.offset),
    [20, 20],
  );
  const completedProject = result.current.projects[0];
  assert.equal(completedProject.sessions?.length, 40);
  assert.equal(completedProject.sessions?.filter((session) => session.id === 'later-session').length, 1);
  assert.equal(completedProject.sessionMeta?.nextOffset, 40);
  assert.equal(completedProject.sessionMeta?.hasMore, false);
});

test('deleting a loaded row rewinds the canonical page cursor', async () => {
  projectsResponse.mockResolvedValue(projectResponse([
    buildProject({ sessionMeta: { total: 25, hasMore: true } }),
  ]));
  const { result } = await renderProjectsState();
  await waitFor(() => assert.equal(result.current.projects[0]?.sessions?.length, 20));

  act(() => {
    result.current.handleSessionDelete('page-one-0');
  });
  assert.equal(result.current.projects[0].sessionMeta?.nextOffset, 19);
  assert.equal(result.current.projects[0].sessionMeta?.total, 24);

  projectSessionsResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      projectId: 'project-1',
      sessions: Array.from({ length: 5 }, (_, index) => ({
        id: `remaining-${index}`,
        summary: `Remaining ${index}`,
        provider: 'claude' as const,
      })),
      sessionMeta: { total: 24, hasMore: false },
    }),
  });
  await act(async () => {
    await result.current.loadMoreProjectSessions('project-1');
  });

  assert.equal(projectSessionsResponse.mock.calls[0]?.[1].offset, 19);
  assert.equal(result.current.projects[0].sessions?.length, 24);
  assert.equal(result.current.projects[0].sessionMeta?.nextOffset, 24);
  assert.equal(result.current.projects[0].sessionMeta?.hasMore, false);
});
