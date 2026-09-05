import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Project, StarredSessionListItem } from '@/shared/types';
import { useSidebarController } from '@/modules/sidebar/hooks/useSidebarController';

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({
    refreshProjects: vi.fn(),
  }),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settled) => {
    resolve = settled;
  });
  return { promise, resolve };
};

const jsonResponse = (body: unknown, ok = true): Response =>
  ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const starredSession = (): StarredSessionListItem => ({
  sessionId: 'session-1',
  provider: 'claude',
  projectId: 'project-1',
  projectPath: '/tmp/project-1',
  projectDisplayName: 'Project 1',
  sessionTitle: 'Session 1',
  createdAt: '2026-08-21T10:00:00.000Z',
  updatedAt: '2026-08-21T10:00:00.000Z',
  lastActivity: '2026-08-21T10:00:00.000Z',
  isArchived: false,
  isProjectArchived: false,
  isOneShot: false,
});

const project: Project = {
  projectId: 'project-1',
  displayName: 'Project 1',
  fullPath: '/tmp/project-1',
  sessions: [
    {
      id: 'session-1',
      summary: 'Session 1',
      provider: 'claude',
      __provider: 'claude',
      __projectId: 'project-1',
    },
  ],
  sessionMeta: { total: 1, hasMore: false },
};

const emptySet: ReadonlySet<string> = new Set();
const emptyMap = new Map();
const t = ((key: string) => key) as TFunction;

const controllerArgs = {
  projects: [project],
  selectedProject: null,
  selectedSession: null,
  activeSessions: emptySet,
  terminalRunningSessions: emptyMap,
  recentWebSessions: emptyMap,
  isLoading: false,
  isMobile: false,
  t,
  onRefresh: vi.fn(async () => undefined),
  onProjectSelect: vi.fn(),
  onSessionSelect: vi.fn(),
  onNewSession: vi.fn(),
  onSessionDelete: vi.fn(),
  onLoadMoreSessions: vi.fn(async () => undefined),
  onHydrateRunningSessions: vi.fn(async () => undefined),
  refreshRunningSessions: vi.fn(async () => new Set<string>()),
  onProjectDelete: vi.fn(),
  setCurrentProject: vi.fn(),
  setSidebarVisible: vi.fn(),
  sidebarVisible: true,
};


const installArchiveMocks = () => {
  vi.spyOn(api, 'archivedProjects').mockResolvedValue(
    jsonResponse({ data: { projects: [] } }),
  );
  vi.spyOn(api, 'getArchivedSessions').mockResolvedValue(
    jsonResponse({ data: { sessions: [] } }),
  );
};

beforeEach(() => {
  localStorage.clear();
  installArchiveMocks();
});

test('an accepted refresh resets the next click to the current server state', async () => {
  const starred = starredSession();
  const starredResponses = [
    jsonResponse({ data: { sessions: [starred] } }),
    jsonResponse({ data: { sessions: [] } }),
    jsonResponse({ data: { sessions: [starred] } }),
  ];
  const starredSessions = vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    starredResponses.shift() ?? jsonResponse({ data: { sessions: [starred] } }),
  );
  const toggleSessionStar = vi.spyOn(api, 'toggleSessionStar').mockResolvedValue(
    jsonResponse({ data: { isStarred: true } }),
  );

  const view = renderHook(() => useSidebarController(controllerArgs));


  await waitFor(() => {
    assert.equal(view.result.current.isSessionStarred('session-1'), true);
  });

  await act(async () => {
    await view.result.current.refreshProjects();
  });

  assert.equal(view.result.current.isSessionStarred('session-1'), false);

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(toggleSessionStar.mock.calls.length, 1));
  });

  assert.deepEqual(toggleSessionStar.mock.calls[0], ['session-1', true]);
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), true));
  assert.equal(starredSessions.mock.calls.length, 3);
});

test('an authoritative post-toggle refresh clears the overlay before the next click', async () => {
  const starred = starredSession();
  const starredResponses = [
    jsonResponse({ data: { sessions: [] } }),
    jsonResponse({ data: { sessions: [] } }),
    jsonResponse({ data: { sessions: [starred] } }),
  ];
  const starredSessions = vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    starredResponses.shift() ?? jsonResponse({ data: { sessions: [starred] } }),
  );
  const toggleSessionStar = vi.spyOn(api, 'toggleSessionStar').mockResolvedValue(
    jsonResponse({ data: { isStarred: true } }),
  );

  const view = renderHook(() => useSidebarController(controllerArgs));

  await waitFor(() => {
    assert.equal(view.result.current.isSessionStarred('session-1'), false);
  });

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(toggleSessionStar.mock.calls.length, 1));
  });
  await waitFor(() => assert.equal(starredSessions.mock.calls.length, 2));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), false));

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(toggleSessionStar.mock.calls.length, 2));
  });

  assert.deepEqual(toggleSessionStar.mock.calls, [
    ['session-1', true],
    ['session-1', true],
  ]);
});

test('a stale successful toggle refresh settles against the newest accepted list', async () => {
  const starred = starredSession();
  const toggleRefresh = deferred<Response>();
  const independentRefresh = deferred<Response>();
  let starredCall = 0;
  const starredSessions = vi.spyOn(api, 'starredSessions').mockImplementation(async () => {
    starredCall += 1;
    if (starredCall === 1) {
      return jsonResponse({ data: { sessions: [] } });
    }
    if (starredCall === 2) {
      return toggleRefresh.promise;
    }
    if (starredCall === 3) {
      return independentRefresh.promise;
    }
    return jsonResponse({ data: { sessions: [starred] } });
  });
  const toggleSessionStar = vi.spyOn(api, 'toggleSessionStar').mockResolvedValue(
    jsonResponse({ data: { isStarred: true } }),
  );

  const view = renderHook(() => useSidebarController(controllerArgs));

  await waitFor(() => {
    assert.equal(view.result.current.isSessionStarred('session-1'), false);
  });

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(starredSessions.mock.calls.length, 2));
  });

  let refreshPromise!: Promise<void>;
  await act(async () => {
    refreshPromise = view.result.current.refreshProjects();
    await waitFor(() => assert.equal(starredSessions.mock.calls.length, 3));
  });

  independentRefresh.resolve(jsonResponse({ data: { sessions: [] } }));
  await act(async () => {
    await refreshPromise;
  });

  toggleRefresh.resolve(jsonResponse({ data: { sessions: [] } }));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), false));

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(toggleSessionStar.mock.calls.length, 2));
  });

  assert.deepEqual(toggleSessionStar.mock.calls, [
    ['session-1', true],
    ['session-1', true],
  ]);
});

test('a stale toggle recovery does not roll back a newer refresh or alert', async () => {
  const starred = starredSession();
  const recovery = deferred<Response>();
  const newerRefresh = deferred<Response>();
  let starredCall = 0;
  const starredSessions = vi.spyOn(api, 'starredSessions').mockImplementation(async () => {
    starredCall += 1;
    if (starredCall === 1) {
      return jsonResponse({ data: { sessions: [starred] } });
    }
    if (starredCall === 2) {
      return recovery.promise;
    }
    return newerRefresh.promise;
  });
  vi.spyOn(api, 'toggleSessionStar').mockResolvedValue(
    jsonResponse({ error: 'toggle response lost' }, false),
  );
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);

  const view = renderHook(() => useSidebarController(controllerArgs));

  await waitFor(() => {
    assert.equal(view.result.current.isSessionStarred('session-1'), true);
  });

  await act(async () => {
    view.result.current.toggleStarSession('session-1');
    await waitFor(() => assert.equal(starredSessions.mock.calls.length, 2));
  });

  let refreshPromise!: Promise<void>;
  await act(async () => {
    refreshPromise = view.result.current.refreshProjects();
    await waitFor(() => assert.equal(starredSessions.mock.calls.length, 3));
  });

  newerRefresh.resolve(jsonResponse({ data: { sessions: [] } }));
  await act(async () => {
    await refreshPromise;
  });

  recovery.resolve(jsonResponse({ data: { sessions: [] } }));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), false));

  assert.equal(alert.mock.calls.length, 0);
  assert.equal(starredCall, 3);
});
