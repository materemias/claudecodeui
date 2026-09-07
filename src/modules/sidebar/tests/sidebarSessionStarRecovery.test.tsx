import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';
import type { Project, ServerEvent, StarredSessionListItem } from '@/shared/types';
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


const websocketListeners = new Set<(event: ServerEvent) => void>();
const subscribe = (listener: (event: ServerEvent) => void) => {
  websocketListeners.add(listener);
  return () => {
    websocketListeners.delete(listener);
  };
};
const dispatch = (kind: string, provider?: string) => {
  for (const listener of websocketListeners) {
    listener({ kind, provider });
  }
};
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
  subscribe,
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
  websocketListeners.clear();
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

test('pin invalidations and reconnects replace common starred membership without refreshing projects', async () => {
  const starred = { ...starredSession(), provider: 'omp' as const };
  const starredAfterReconnect = { ...starred, sessionId: 'session-2', sessionTitle: 'Session 2' };
  let sessions: StarredSessionListItem[] = [];
  vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    jsonResponse({ data: { sessions } }),
  );
  const onRefresh = vi.fn(async () => undefined);
  const view = renderHook(() => useSidebarController({ ...controllerArgs, onRefresh }));
  await waitFor(() => assert.equal(view.result.current.starredSessionsLoaded, true));

  sessions = [starred];
  act(() => dispatch('session_stars_changed'));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), true));

  // A native unpin and a different pin happened while this socket was offline.
  sessions = [starredAfterReconnect];
  act(() => dispatch('websocket_reconnected'));
  await waitFor(() => {
    assert.equal(view.result.current.isSessionStarred('session-1'), false);
    assert.equal(view.result.current.isSessionStarred('session-2'), true);
  });
  assert.equal(onRefresh.mock.calls.length, 0);
});

test('live refreshes preserve an in-flight desired star while accepting other native pin changes', async () => {
  const starred = { ...starredSession(), provider: 'omp' as const };
  const otherStarred = { ...starred, sessionId: 'session-2', sessionTitle: 'Session 2' };
  const toggleResponse = deferred<Response>();
  let sessions: StarredSessionListItem[] = [];
  vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    jsonResponse({ data: { sessions } }),
  );
  vi.spyOn(api, 'toggleSessionStar').mockReturnValue(toggleResponse.promise);
  const view = renderHook(() => useSidebarController(controllerArgs));
  await waitFor(() => assert.equal(view.result.current.starredSessionsLoaded, true));

  act(() => view.result.current.toggleStarSession('session-1'));
  assert.equal(view.result.current.isSessionStarred('session-1'), true);

  sessions = [otherStarred];
  act(() => dispatch('session_stars_changed'));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-2'), true));
  assert.equal(view.result.current.isSessionStarred('session-1'), true);

  sessions = [];
  act(() => dispatch('websocket_reconnected'));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-2'), false));
  assert.equal(view.result.current.isSessionStarred('session-1'), true);

  sessions = [starred];
  await act(async () => {
    toggleResponse.resolve(jsonResponse({ data: { isStarred: true } }));
    await toggleResponse.promise;
  });
  await waitFor(() => assert.equal(view.result.current.isStarredSessionsLoading, false));
  assert.equal(view.result.current.isSessionStarred('session-1'), true);
});

test('a native unpin reruns capped starred search to reveal the next matching session', async () => {
  const first = { ...starredSession(), provider: 'omp' as const };
  const second = { ...first, sessionId: 'session-2', sessionTitle: 'Session 2' };
  let sessions: StarredSessionListItem[] = [first, second];
  vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    jsonResponse({ data: { sessions } }),
  );
  vi.spyOn(api, 'recentConversations').mockResolvedValue(
    jsonResponse({ data: { conversations: [], total: 0, hasMore: false } }),
  );

  class CappedSearchStream extends EventTarget {
    closed = false;

    constructor(url: string) {
      super();
      assert.equal(new URL(url, window.location.origin).searchParams.get('starredOnly'), 'true');
      const titleResults = sessions.slice(0, 1);
      queueMicrotask(() => {
        if (this.closed) {
          return;
        }
        this.dispatchEvent(new MessageEvent('title-results', {
          data: JSON.stringify({ titleResults }),
        }));
        this.dispatchEvent(new Event('done'));
      });
    }

    close() {
      this.closed = true;
    }
  }

  vi.stubGlobal('EventSource', CappedSearchStream);
  const view = renderHook(() => useSidebarController(controllerArgs));
  try {
    await waitFor(() => assert.equal(view.result.current.starredSessionsLoaded, true));
    act(() => {
      view.result.current.toggleStarredSessionsOnly();
      view.result.current.setSearchFilter('Session');
      view.result.current.setSearchMode('conversations');
    });
    await waitFor(() => assert.deepEqual(
      view.result.current.conversationResults?.titleResults.map((session) => session.sessionId),
      ['session-1'],
    ));

    sessions = [second];
    act(() => dispatch('session_stars_changed'));
    await waitFor(() => assert.deepEqual(
      view.result.current.conversationResults?.titleResults.map((session) => session.sessionId),
      ['session-2'],
    ));
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});

test('native pin changes replace only starred running rows, excluding idle pinned sessions', async () => {
  const first = { ...starredSession(), provider: 'omp' as const };
  const second = { ...first, sessionId: 'session-2', sessionTitle: 'Session 2' };
  const idle = { ...first, sessionId: 'idle-session', sessionTitle: 'Idle session' };
  let sessions: StarredSessionListItem[] = [first, idle];
  vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    jsonResponse({ data: { sessions } }),
  );
  const runningProject: Project = {
    ...project,
    sessions: [first, second, idle].map((session) => ({
      id: session.sessionId,
      summary: session.sessionTitle,
      provider: session.provider,
      __provider: session.provider,
      __projectId: project.projectId,
    })),
    sessionMeta: { total: 3, hasMore: false },
  };
  const activeSessions = new Set(['session-1', 'session-2']);
  const runningArgs = {
    ...controllerArgs,
    projects: [runningProject],
    activeSessions,
  };
  const view = renderHook(() => useSidebarController(runningArgs));
  await waitFor(() => assert.equal(view.result.current.starredSessionsLoaded, true));
  act(() => {
    view.result.current.setSearchMode('running');
    view.result.current.toggleStarredSessionsOnly();
  });
  assert.deepEqual(
    view.result.current.filteredProjects.flatMap((entry) => entry.sessions?.map((session) => session.id) ?? []),
    ['session-1'],
  );

  sessions = [second, idle];
  act(() => dispatch('session_stars_changed'));
  await waitFor(() => assert.deepEqual(
    view.result.current.filteredProjects.flatMap((entry) => entry.sessions?.map((session) => session.id) ?? []),
    ['session-2'],
  ));

  act(() => view.result.current.toggleStarredSessionsOnly());
  assert.deepEqual(
    view.result.current.filteredProjects.flatMap((entry) => entry.sessions?.map((session) => session.id) ?? []),
    ['session-1', 'session-2'],
  );
});

test('a native pin becomes visible when transcript indexing follows the pin notification', async () => {
  const starred = { ...starredSession(), provider: 'omp' as const };
  let sessions: StarredSessionListItem[] = [];
  const fetchStars = vi.spyOn(api, 'starredSessions').mockImplementation(async () =>
    jsonResponse({ data: { sessions } }),
  );
  const view = renderHook(() => useSidebarController(controllerArgs));
  await waitFor(() => assert.equal(view.result.current.starredSessionsLoaded, true));
  act(() => dispatch('session_stars_changed'));
  await waitFor(() => assert.equal(fetchStars.mock.calls.length, 2));
  assert.equal(view.result.current.isSessionStarred('session-1'), false);

  sessions = [starred];
  act(() => dispatch('session_upserted', 'omp'));
  await waitFor(() => assert.equal(view.result.current.isSessionStarred('session-1'), true));
});
