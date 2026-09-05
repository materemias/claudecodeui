import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { subscribeToUserPreferences } from '@/shared/userSettings';
import { usePaletteOps } from '@/modules/command-palette';
import type { ArchivedProjectListItem, ArchivedSessionListItem, ConversationProjectResult, ConversationSearchResults, LLMProvider, Project, ProjectSession, ProjectSortOrder, RecentConversationListItem, RecentWebSessionMap, SearchProgress, ActiveSidebarRename, PendingSidebarDeletion, SessionTitleSearchResult, SessionWithProvider, SidebarSearchMode, StarredSessionListItem, TerminalRunningSessionMap } from '@/shared/types';
import {
  filterProjects,
  getAllSessions,
  sortProjects,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  clearLegacyStarredProjectIds,
  readLegacyStarredProjectIds,
  readProjectSortOrder,
  readStarredSessionsOnly,
  writeStarredSessionsOnly,
} from '@/modules/sidebar/utils/sidebarStoredPreferences';


type ArchivedSessionsApiPayload = {
  success?: boolean;
  data?: {
    sessions?: ArchivedSessionListItem[];
  };
};

type ArchivedProjectsApiPayload = {
  success?: boolean;
  data?: {
    projects?: ArchivedProjectListItem[];
  };
};

type RecentConversationsApiPayload = {
  success?: boolean;
  data?: {
    conversations?: RecentConversationListItem[];
    total?: number;
    hasMore?: boolean;
  };
};

type StarredSessionsApiPayload = {
  success?: boolean;
  data?: {
    sessions?: StarredSessionListItem[];
  };
};

/** Describes whether a starred-session refresh updated state, became stale, or failed. */
type StarredSessionsFetchResult =
  | { kind: 'applied'; sessions: StarredSessionListItem[] }
  | { kind: 'stale' }
  | { kind: 'failed' };

/** Records the latest starred-session refresh outcome for toggle settlement. */
type StarredSessionsRefreshState = {
  sequence: number;
  kind: 'applied' | 'failed';
};


type UseSidebarControllerArgs = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeSessions: ReadonlySet<string>;
  terminalRunningSessions: TerminalRunningSessionMap;
  recentWebSessions: RecentWebSessionMap;
  isLoading: boolean;
  isMobile: boolean;
  t: TFunction;
  onRefresh: () => Promise<void> | void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: ProjectSession) => void;
  onNewSession: (project: Project) => void;
  onSessionDelete?: (sessionId: string) => void;
  onLoadMoreSessions?: (projectId: string) => Promise<void> | void;
  onHydrateRunningSessions: (sessionIds: ReadonlySet<string>) => Promise<void>;
  refreshRunningSessions: () => Promise<ReadonlySet<string> | null>;
  // `projectId` is the DB-assigned identifier; callbacks use that post-migration.
  onProjectDelete?: (projectId: string) => void;
  setCurrentProject: (project: Project) => void;
  setSidebarVisible: (visible: boolean) => void;
  sidebarVisible: boolean;
};

/** Used by the sidebar controller and its pagination regression test to build the complete Running view. */
export function buildRunningProjects(
  projects: Project[],
  runningSessionIds: ReadonlySet<string>,
  recentWebSessions: RecentWebSessionMap,
  projectSortOrder: ProjectSortOrder,
): Project[] {
  if (runningSessionIds.size === 0) {
    return [];
  }

  const recentSessionsByProject = new Map<string, ProjectSession[]>();
  for (const session of recentWebSessions.values()) {
    if (session.isOneShot === true) {
      continue;
    }

    const projectSessions = recentSessionsByProject.get(session.projectId) ?? [];
    const retainedSession: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      lastActivity: session.lastActivity ?? undefined,
      provider: session.provider,
      __provider: session.provider,
      __projectId: session.projectId,
    };
    if (typeof session.isOneShot === 'boolean') {
      retainedSession.isOneShot = session.isOneShot;
    }
    projectSessions.push(retainedSession);
    recentSessionsByProject.set(session.projectId, projectSessions);
  }

  const projectsWithRunningSessions = projects.reduce<Project[]>((acc, project) => {
    const sessions = (project.sessions ?? []).filter(
      (session) =>
        session.isOneShot !== true
        && runningSessionIds.has(String(session.id)),
    );
    const sessionIds = new Set(sessions.map((session) => String(session.id)));

    for (const session of recentSessionsByProject.get(project.projectId) ?? []) {
      if (!sessionIds.has(session.id)) {
        sessions.push(session);
      }
    }

    if (sessions.length === 0) {
      return acc;
    }

    acc.push({
      ...project,
      sessions,
      sessionMeta: {
        ...project.sessionMeta,
        total: sessions.length,
        hasMore: false,
      },
    });
    return acc;
  }, []);

  return sortProjects(projectsWithRunningSessions, projectSortOrder);
}

/**
 * Used by the sidebar controller and its filter test to build the Projects view
 * while the starred-sessions filter is on.
 *
 * The starred sessions are grafted onto their project rather than filtered out
 * of `project.sessions`, because a starred session often sits past the page of
 * sessions the project has loaded and a plain filter would simply lose it.
 */
export function buildStarredProjects(
  projects: Project[],
  starredSessions: StarredSessionListItem[],
  projectSortOrder: ProjectSortOrder,
): Project[] {
  if (starredSessions.length === 0) {
    return [];
  }

  const starredSessionsByProject = new Map<string, ProjectSession[]>();
  for (const session of starredSessions) {
    if (
      !session.projectId
      || session.isArchived
      || session.isProjectArchived
      || session.isOneShot
    ) {
      continue;
    }

    const projectSessions = starredSessionsByProject.get(session.projectId) ?? [];
    projectSessions.push({
      id: session.sessionId,
      summary: session.sessionTitle,
      lastActivity: session.lastActivity ?? undefined,
      createdAt: session.createdAt ?? undefined,
      provider: session.provider,
      __provider: session.provider,
      __projectId: session.projectId,
      isOneShot: false,
    });
    starredSessionsByProject.set(session.projectId, projectSessions);
  }

  const projectsWithStarredSessions = projects.reduce<Project[]>((acc, project) => {
    const starredForProject = starredSessionsByProject.get(project.projectId);
    if (!starredForProject) {
      return acc;
    }

    const starredIds = new Set(starredForProject.map((session) => session.id));
    // Loaded sessions win over the grafted ones: they carry the richer metadata
    // (message counts, provider selection) the rows render.
    const sessions = (project.sessions ?? []).filter((session) => starredIds.has(String(session.id)));
    const loadedIds = new Set(sessions.map((session) => String(session.id)));

    for (const session of starredForProject) {
      if (!loadedIds.has(session.id)) {
        sessions.push(session);
      }
    }

    if (sessions.length === 0) {
      return acc;
    }

    acc.push({
      ...project,
      sessions,
      sessionMeta: {
        ...project.sessionMeta,
        total: sessions.length,
        hasMore: false,
      },
    });
    return acc;
  }, []);

  return sortProjects(projectsWithStarredSessions, projectSortOrder);
}

export function useSidebarController({
  projects,
  selectedProject,
  selectedSession: _selectedSession,
  activeSessions,
  terminalRunningSessions,
  recentWebSessions,
  isLoading,
  isMobile,
  t,
  onRefresh,
  onProjectSelect,
  onSessionSelect,
  onNewSession,
  onSessionDelete,
  onLoadMoreSessions,
  onHydrateRunningSessions,
  refreshRunningSessions,
  onProjectDelete,
  setCurrentProject,
  setSidebarVisible,
  sidebarVisible,
}: UseSidebarControllerArgs) {
  const paletteOps = usePaletteOps();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [collapsedRunningProjects, setCollapsedRunningProjects] = useState<Set<string>>(new Set());
  // The one rename the sidebar has open, as a single value so a project and a
  // session cannot both be mid-rename. See ActiveSidebarRename.
  const [activeRename, setActiveRename] = useState<ActiveSidebarRename | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [initialSessionsLoaded, setInitialSessionsLoaded] = useState<Set<string>>(new Set());
  const [currentTime, setCurrentTime] = useState(new Date());
  const [projectSortOrder, setProjectSortOrder] = useState<ProjectSortOrder>('name');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [deletingProjects, setDeletingProjects] = useState<Set<string>>(new Set());
  // The one delete confirmation the sidebar has open. One value because the
  // project and session dialogs are portalled at the same z-index and would
  // otherwise stack. See PendingSidebarDeletion.
  const [pendingDeletion, setPendingDeletion] = useState<PendingSidebarDeletion | null>(null);
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [searchMode, setSearchMode] = useState<SidebarSearchMode>('running');
  const [conversationResults, setConversationResults] = useState<ConversationSearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgress | null>(null);
  const [archivedProjects, setArchivedProjects] = useState<ArchivedProjectListItem[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionListItem[]>([]);
  const [isArchivedSessionsLoading, setIsArchivedSessionsLoading] = useState(false);
  const [recentConversations, setRecentConversations] = useState<RecentConversationListItem[]>([]);
  const [recentConversationsTotal, setRecentConversationsTotal] = useState(0);
  const [recentConversationsHasMore, setRecentConversationsHasMore] = useState(false);
  const [isRecentConversationsLoading, setIsRecentConversationsLoading] = useState(false);
  const [isLoadingMoreRecentConversations, setIsLoadingMoreRecentConversations] = useState(false);
  const [recentConversationsError, setRecentConversationsError] = useState(false);
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [optimisticStarByProjectId, setOptimisticStarByProjectId] = useState<Map<string, boolean>>(new Map());
  const [loadingMoreProjects, setLoadingMoreProjects] = useState<Set<string>>(new Set());
  // Every starred session, fetched apart from the project pages because a star
  // can point at a session no loaded page contains.
  const [starredSessions, setStarredSessions] = useState<StarredSessionListItem[]>([]);
  // This fetch gates the starred-only filter so an unavailable list is not
  // mistaken for a successful empty result.
  const [isStarredSessionsLoading, setIsStarredSessionsLoading] = useState(true);
  // The error stays separate from the list so a failed refresh can retain old
  // stars without hiding the failure.
  const [starredSessionsError, setStarredSessionsError] = useState(false);
  // Distinguishes a first-load failure from a later refresh failure.
  const [starredSessionsLoaded, setStarredSessionsLoaded] = useState(false);
  // The starred-only view filter, restored from the device it was set on.
  const [isStarredSessionsOnly, setIsStarredSessionsOnly] = useState<boolean>(readStarredSessionsOnly);
  // In-flight session star toggles, so a row reflects the click before the
  // server answers. Mirrors optimisticStarByProjectId.
  const [optimisticStarBySessionId, setOptimisticStarBySessionId] = useState<Map<string, boolean>>(new Map());
  const searchSeqRef = useRef(0);
  const recentConversationsSeqRef = useRef(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const starToggleSequenceByProjectRef = useRef<Map<string, number>>(new Map());
  const sessionStarToggleSequenceRef = useRef<Map<string, number>>(new Map());
  // Per-session serialization prevents rapid clicks from reaching the toggle
  // endpoint out of order.
  const sessionStarRequestQueueRef = useRef<Map<string, Promise<void>>>(new Map());
  // Updated synchronously on click so a second click sees the first click's
  // desired state before React renders the optimistic map.
  const sessionStarStateRef = useRef<Map<string, boolean>>(new Map());
  // Only the newest starred-list request may replace the filter's source of
  // truth; mount, refresh, and toggle requests can overlap.
  const starredSessionsFetchSequenceRef = useRef(0);
  // Lets a toggle that saw a stale fetch reconcile against the newest accepted list.
  const latestStarredRefreshRef = useRef<StarredSessionsRefreshState | null>(null);

  const migrationStartedRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  const isSidebarCollapsed = !isMobile && !sidebarVisible;
  const runningSessionIds = useMemo(() => {
    const sessionIds = new Set(activeSessions);
    for (const sessionId of terminalRunningSessions.keys()) {
      sessionIds.add(sessionId);
    }
    for (const sessionId of recentWebSessions.keys()) {
      sessionIds.add(sessionId);
    }
    return sessionIds;
  }, [activeSessions, recentWebSessions, terminalRunningSessions]);
  const runningSessionsCount = runningSessionIds.size;

  useEffect(() => {
    if (!isLoading && runningSessionIds.size > 0) {
      void onHydrateRunningSessions(runningSessionIds);
    }
  }, [isLoading, onHydrateRunningSessions, runningSessionIds]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 60000);

    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setInitialSessionsLoaded(new Set());
  }, [projects]);

  useEffect(() => {
    // Auto-expand only when the selected project identity changes.
    // Depending on the full `selectedProject` object (or `selectedSession`) causes
    // websocket-driven list refreshes to re-open projects users manually collapsed.
    const selectedProjectId = selectedProject?.projectId;
    if (!selectedProjectId) {
      return;
    }

    setExpandedProjects((prev) => {
      if (prev.has(selectedProjectId)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(selectedProjectId);
      return next;
    });
  }, [selectedProject?.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !isLoading) {
      const loadedProjects = new Set<string>();
      projects.forEach((project) => {
        if (project.sessions && project.sessions.length >= 0) {
          loadedProjects.add(project.projectId);
        }
      });
      setInitialSessionsLoaded(loadedProjects);
    }
  }, [projects, isLoading]);

  // The sort order used to be polled once a second (plus a `storage` listener
  // for other tabs) because nothing announced a change. The preference store
  // notifies on every write and on every hydrate, so both are unnecessary.
  useEffect(() => {
    const loadSortOrder = () => {
      setProjectSortOrder(readProjectSortOrder());
    };

    loadSortOrder();
    return subscribeToUserPreferences(loadSortOrder);
  }, []);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  const fetchArchivedSessions = useCallback(async () => {
    setIsArchivedSessionsLoading(true);

    try {
      const [archivedProjectsResponse, archivedSessionsResponse] = await Promise.all([
        api.archivedProjects(),
        api.getArchivedSessions(),
      ]);

      if (!archivedProjectsResponse.ok) {
        throw new Error(`Failed to load archived projects: ${archivedProjectsResponse.status}`);
      }

      if (!archivedSessionsResponse.ok) {
        throw new Error(`Failed to load archived sessions: ${archivedSessionsResponse.status}`);
      }

      const archivedProjectsPayload = (await archivedProjectsResponse.json()) as ArchivedProjectsApiPayload;
      const archivedSessionsPayload = (await archivedSessionsResponse.json()) as ArchivedSessionsApiPayload;
      const nextProjects = (Array.isArray(archivedProjectsPayload.data?.projects)
        ? archivedProjectsPayload.data.projects
        : []).map((project) => {
          const sessions = (project.sessions ?? []).filter((session) => session.isOneShot !== true);
          if (sessions.length === (project.sessions ?? []).length) {
            return project;
          }
          return {
            ...project,
            sessions,
            sessionMeta: {
              ...project.sessionMeta,
              total: sessions.length,
              hasMore: false,
            },
          };
        });
      const archivedProjectIds = new Set(nextProjects.map((project) => project.projectId));
      const nextStandaloneSessions = Array.isArray(archivedSessionsPayload.data?.sessions)
        ? archivedSessionsPayload.data.sessions.filter((session) =>
            session.isOneShot !== true
            && (!session.projectId || !archivedProjectIds.has(session.projectId)))
        : [];

      setArchivedProjects(nextProjects);
      setArchivedSessions(nextStandaloneSessions);
    } catch (error) {
      console.error('[Sidebar] Failed to load archived sessions:', error);
    } finally {
      setIsArchivedSessionsLoading(false);
    }
  }, []);

  const fetchStarredSessions = useCallback(async (): Promise<StarredSessionsFetchResult> => {
    const requestSequence = ++starredSessionsFetchSequenceRef.current;
    setIsStarredSessionsLoading(true);
    setStarredSessionsError(false);
    try {
      const response = await api.starredSessions();
      if (!response.ok) {
        throw new Error(`Failed to load starred sessions: ${response.status}`);
      }

      const payload = (await response.json()) as StarredSessionsApiPayload;
      if (!Array.isArray(payload.data?.sessions)) {
        throw new Error('Starred sessions response did not contain a session list');
      }

      if (starredSessionsFetchSequenceRef.current !== requestSequence) {
        return { kind: 'stale' };
      }
      latestStarredRefreshRef.current = { sequence: requestSequence, kind: 'applied' };


      // A completed refresh is authoritative for every session without an
      // in-flight toggle. Preserve only desired states owned by queued writes.
      const queuedSessionIds = new Set(sessionStarRequestQueueRef.current.keys());
      for (const trackedSessionId of sessionStarStateRef.current.keys()) {
        if (!queuedSessionIds.has(trackedSessionId)) {
          sessionStarStateRef.current.delete(trackedSessionId);
        }
      }
      // Accepted refreshes replace the optimistic overlay unless a serialized
      // toggle still owns that session's desired state.
      setOptimisticStarBySessionId((previous) => {
        if (previous.size === 0) {
          return previous;
        }

        const next = new Map(previous);
        let changed = false;
        for (const sessionId of previous.keys()) {
          if (!queuedSessionIds.has(sessionId)) {
            next.delete(sessionId);
            changed = true;
          }
        }

        return changed ? next : previous;
      });


      setStarredSessions(payload.data.sessions);
      setStarredSessionsLoaded(true);
      return { kind: 'applied', sessions: payload.data.sessions };
    } catch (error) {
      if (starredSessionsFetchSequenceRef.current !== requestSequence) {
        return { kind: 'stale' };
      }
      latestStarredRefreshRef.current = { sequence: requestSequence, kind: 'failed' };


      // The previous list stays in place: a failed refetch must not empty the
      // filter out from under the user.
      setStarredSessionsError(true);
      console.error('[Sidebar] Failed to load starred sessions:', error);
      return { kind: 'failed' };
    } finally {
      if (starredSessionsFetchSequenceRef.current === requestSequence) {
        setIsStarredSessionsLoading(false);
      }
    }
  }, []);


  const fetchRecentConversationsPage = useCallback(async (offset: number, append: boolean) => {
    const requestSequence = ++recentConversationsSeqRef.current;
    if (append) {
      setIsLoadingMoreRecentConversations(true);
    } else {
      setIsRecentConversationsLoading(true);
    }
    setRecentConversationsError(false);

    try {
      const response = await api.recentConversations({ limit: 40, offset });
      if (!response.ok) {
        throw new Error(`Failed to load recent conversations: ${response.status}`);
      }

      const payload = (await response.json()) as RecentConversationsApiPayload;
      const conversations = Array.isArray(payload.data?.conversations)
        ? payload.data.conversations.filter((conversation) => conversation.isOneShot !== true)
        : [];

      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }

      setRecentConversations((previous) => {
        if (!append) {
          return conversations;
        }

        const existingIds = new Set(previous.map((conversation) => conversation.sessionId));
        return [
          ...previous,
          ...conversations.filter((conversation) => !existingIds.has(conversation.sessionId)),
        ];
      });
      setRecentConversationsTotal(Number(payload.data?.total ?? conversations.length));
      setRecentConversationsHasMore(Boolean(payload.data?.hasMore));
    } catch (error) {
      if (requestSequence !== recentConversationsSeqRef.current) {
        return;
      }
      console.error('[Sidebar] Failed to load recent conversations:', error);
      setRecentConversationsError(true);
    } finally {
      if (requestSequence === recentConversationsSeqRef.current) {
        setIsRecentConversationsLoading(false);
        setIsLoadingMoreRecentConversations(false);
      }
    }
  }, []);

  const reloadRecentConversations = useCallback(() => {
    void fetchRecentConversationsPage(0, false);
  }, [fetchRecentConversationsPage]);

  const loadMoreRecentConversations = useCallback(() => {
    // Under the starred filter the list is the starred sessions themselves, so
    // there are no further pages to fetch.
    if (isStarredSessionsOnly || isLoadingMoreRecentConversations || !recentConversationsHasMore) {
      return;
    }
    void fetchRecentConversationsPage(recentConversations.length, true);
  }, [
    fetchRecentConversationsPage,
    isLoadingMoreRecentConversations,
    isStarredSessionsOnly,
    recentConversations.length,
    recentConversationsHasMore,
  ]);

  useEffect(() => {
    if (migrationStartedRef.current) {
      return;
    }

    const legacyStarredProjectIds = readLegacyStarredProjectIds();
    if (legacyStarredProjectIds.length === 0) {
      return;
    }

    migrationStartedRef.current = true;

    const migrateLegacyStars = async () => {
      try {
        await api.migrateLegacyProjectStars(legacyStarredProjectIds);
        await onRefreshRef.current();
      } catch (error) {
        console.error('[Sidebar] Failed to migrate legacy starred projects:', error);
      } finally {
        clearLegacyStarredProjectIds();
      }
    };

    void migrateLegacyStars();
  }, [onRefresh]);

  useEffect(() => {
    void fetchArchivedSessions();
  }, [fetchArchivedSessions]);

  useEffect(() => {
    void fetchStarredSessions();
  }, [fetchStarredSessions]);

  useEffect(() => {
    if (searchMode !== 'conversations' || debouncedSearchQuery.length >= 2) {
      return;
    }

    reloadRecentConversations();
  }, [debouncedSearchQuery, reloadRecentConversations, searchMode]);

  useEffect(() => {
    if (searchMode !== 'archived') {
      return;
    }

    // Refresh archive contents when the archived tab opens so restore actions
    // and background synchronizer updates are reflected without a full reload.
    void fetchArchivedSessions();
  }, [fetchArchivedSessions, searchMode]);

  useEffect(() => {
    setOptimisticStarByProjectId((previous) => {
      if (previous.size === 0) {
        return previous;
      }

      const next = new Map(previous);
      let changed = false;

      for (const [projectId, optimisticValue] of previous.entries()) {
        const project = projects.find((candidate) => candidate.projectId === projectId);
        if (!project) {
          next.delete(projectId);
          changed = true;
          continue;
        }

        if (Boolean(project.isStarred) === optimisticValue) {
          next.delete(projectId);
          changed = true;
        }
      }

      return changed ? next : previous;
    });
  }, [projects]);


  // Debounce search text updates so both project filtering and conversation
  // SSE requests avoid running on every keypress.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearchQuery(searchFilter.trim());
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [searchFilter]);

  // Debounced conversation search with SSE streaming
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const query = debouncedSearchQuery;
    if (searchMode !== 'conversations' || query.length < 2) {
      searchSeqRef.current += 1;
      setConversationResults(null);
      setSearchProgress(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setConversationResults(null);
    setSearchProgress(null);
    const seq = ++searchSeqRef.current;

    if (seq !== searchSeqRef.current) {
      return;
    }

    const url = api.searchConversationsUrl(query, 50, isStarredSessionsOnly);
    const es = new EventSource(url);
    eventSourceRef.current = es;

    const accumulated: ConversationProjectResult[] = [];
    let titleResults: SessionTitleSearchResult[] = [];
    let totalMatches = 0;

    es.addEventListener('title-results', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { titleResults: SessionTitleSearchResult[] };
        titleResults = Array.isArray(data.titleResults) ? data.titleResults : [];
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('result', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as {
          projectResult: ConversationProjectResult;
          totalMatches: number;
          scannedProjects: number;
          totalProjects: number;
        };
        accumulated.push(data.projectResult);
        totalMatches = data.totalMatches;
        setConversationResults({
          results: [...accumulated],
          titleResults: [...titleResults],
          totalMatches,
          query,
        });
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('progress', (evt) => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      try {
        const data = JSON.parse(evt.data) as { totalMatches: number; scannedProjects: number; totalProjects: number };
        totalMatches = data.totalMatches;
        setSearchProgress({ scannedProjects: data.scannedProjects, totalProjects: data.totalProjects });
      } catch {
        // Ignore malformed SSE data
      }
    });

    es.addEventListener('done', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    es.addEventListener('error', () => {
      if (seq !== searchSeqRef.current) { es.close(); return; }
      es.close();
      eventSourceRef.current = null;
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults({
        results: [...accumulated],
        titleResults: [...titleResults],
        totalMatches,
        query,
      });
    });

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [debouncedSearchQuery, isStarredSessionsOnly, searchMode]);

  // All sidebar state keys (expanded, starred, loading, etc.) use the DB
  // `projectId` as their identifier after the migration.
  const toggleProject = useCallback(
    (projectId: string) => {
      if (searchMode === 'running') {
        setCollapsedRunningProjects((prev) => {
          const next = new Set(prev);
          if (!next.delete(projectId)) {
            next.add(projectId);
          }
          return next;
        });
        return;
      }

      setExpandedProjects((prev) => {
        const next = new Set<string>();
        if (!prev.has(projectId)) {
          next.add(projectId);
        }
        return next;
      });
    },
    [searchMode],
  );

  const isProjectExpanded = useCallback(
    (projectId: string) =>
      searchMode === 'running'
        ? !collapsedRunningProjects.has(projectId)
        : expandedProjects.has(projectId),
    [collapsedRunningProjects, expandedProjects, searchMode],
  );

  const handleSessionClick = useCallback(
    (session: SessionWithProvider, projectId: string) => {
      // Tag the session with its owning projectId so downstream handlers
      // can correlate it with the selectedProject in the app state.
      onSessionSelect({ ...session, __projectId: projectId });
    },
    [onSessionSelect],
  );

  const resolveProjectStarState = useCallback(
    (projectId: string): boolean => {
      if (optimisticStarByProjectId.has(projectId)) {
        return Boolean(optimisticStarByProjectId.get(projectId));
      }

      return projects.some((project) => project.projectId === projectId && Boolean(project.isStarred));
    },
    [optimisticStarByProjectId, projects],
  );

  const toggleStarProject = useCallback((projectId: string) => {
    const previousStarState = resolveProjectStarState(projectId);
    const optimisticStarState = !previousStarState;
    const latestSequence = (starToggleSequenceByProjectRef.current.get(projectId) ?? 0) + 1;
    starToggleSequenceByProjectRef.current.set(projectId, latestSequence);

    setOptimisticStarByProjectId((previous) => {
      const next = new Map(previous);
      next.set(projectId, optimisticStarState);
      return next;
    });

    const updateStar = async () => {
      try {
        const response = await api.toggleProjectStar(projectId);
        if (!response.ok) {
          const payload = (await response.json()) as { error?: string | { message?: string } };
          const errorPayload = payload.error;
          const message =
            typeof errorPayload === 'string'
              ? errorPayload
              : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                ? errorPayload.message
                : t('messages.updateProjectError');
          throw new Error(message);
        }

        const payload = (await response.json()) as { isStarred?: boolean };
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, Boolean(payload.isStarred));
          return next;
        });
      } catch (error) {
        const isLatestSequence = starToggleSequenceByProjectRef.current.get(projectId) === latestSequence;
        if (!isLatestSequence) {
          return;
        }

        setOptimisticStarByProjectId((previous) => {
          const next = new Map(previous);
          next.set(projectId, previousStarState);
          return next;
        });
        console.error('[Sidebar] Failed to toggle project star:', error);
        alert(t('messages.updateProjectError'));
      }
    };

    void updateStar();
  }, [resolveProjectStarState, t]);

  const isProjectStarred = useCallback(
    (projectId: string) => resolveProjectStarState(projectId),
    [resolveProjectStarState],
  );

  // The fetched stars with in-flight toggles applied, so a row and every filter
  // agree on one answer for "is this session starred".
  const starredSessionIds = useMemo(() => {
    const sessionIds = new Set(starredSessions.map((session) => session.sessionId));
    for (const [sessionId, optimisticValue] of optimisticStarBySessionId.entries()) {
      if (optimisticValue) {
        sessionIds.add(sessionId);
      } else {
        sessionIds.delete(sessionId);
      }
    }
    return sessionIds;
  }, [optimisticStarBySessionId, starredSessions]);

  const isSessionStarred = useCallback(
    (sessionId: string) => starredSessionIds.has(sessionId),
    [starredSessionIds],
  );

  const toggleStarSession = useCallback((sessionId: string) => {
    const previousStarState =
      sessionStarStateRef.current.get(sessionId) ?? starredSessionIds.has(sessionId);
    const desiredStarState = !previousStarState;
    sessionStarStateRef.current.set(sessionId, desiredStarState);
    const latestSequence = (sessionStarToggleSequenceRef.current.get(sessionId) ?? 0) + 1;
    sessionStarToggleSequenceRef.current.set(sessionId, latestSequence);

    setOptimisticStarBySessionId((previous) => {
      const next = new Map(previous);
      next.set(sessionId, desiredStarState);
      return next;
    });

    const previousRequest = sessionStarRequestQueueRef.current.get(sessionId) ?? Promise.resolve();
    const updateStar = previousRequest
      .catch(() => undefined)
      .then(async () => {
        try {
          const response = await api.toggleSessionStar(sessionId, desiredStarState);
          if (!response.ok) {
            const payload = (await response.json()) as { error?: string | { message?: string } };
            const errorPayload = payload.error;
            const message =
              typeof errorPayload === 'string'
                ? errorPayload
                : errorPayload && typeof errorPayload === 'object' && errorPayload.message
                  ? errorPayload.message
                  : t('messages.updateSessionError', 'Failed to update session. Please try again.');
            throw new Error(message);
          }

          const payload = (await response.json()) as { data?: { isStarred?: unknown } };
          if (typeof payload.data?.isStarred !== 'boolean') {
            throw new Error('Session star response did not contain a valid state');
          }
          const serverStarState = payload.data.isStarred;

          const isLatestSequence = sessionStarToggleSequenceRef.current.get(sessionId) === latestSequence;
          if (!isLatestSequence) {
            return;
          }

          sessionStarStateRef.current.set(sessionId, serverStarState);
          setOptimisticStarBySessionId((previous) => {
            const next = new Map(previous);
            next.set(sessionId, serverStarState);
            return next;
          });

          // The list carries the metadata the filtered views graft onto projects,
          // so it is reread whenever a star lands.
          const refreshResult = await fetchStarredSessions();
          if (
            refreshResult.kind === 'applied'
            && sessionStarToggleSequenceRef.current.get(sessionId) === latestSequence
          ) {
            // The accepted list is authoritative now that this toggle's
            // refresh completed; the request queue still gets cleaned up in
            // the finally handler below.
            sessionStarStateRef.current.delete(sessionId);
            setOptimisticStarBySessionId((previous) => {
              if (!previous.has(sessionId)) {
                return previous;
              }

              const next = new Map(previous);
              next.delete(sessionId);
              return next;
            });
          }
        } catch (error) {
          const isLatestSequence = sessionStarToggleSequenceRef.current.get(sessionId) === latestSequence;
          if (!isLatestSequence) {
            return;
          }

          const refreshResult = await fetchStarredSessions();
          if (sessionStarToggleSequenceRef.current.get(sessionId) !== latestSequence) {
            return;
          }

          if (refreshResult.kind === 'stale') {
            return;
          }

          if (refreshResult.kind === 'applied') {
            const serverStarState = refreshResult.sessions.some((session) => session.sessionId === sessionId);
            sessionStarStateRef.current.set(sessionId, serverStarState);
            setOptimisticStarBySessionId((previous) => {
              const next = new Map(previous);
              next.delete(sessionId);
              return next;
            });
          } else {
            sessionStarStateRef.current.set(sessionId, previousStarState);
            setOptimisticStarBySessionId((previous) => {
              const next = new Map(previous);
              next.set(sessionId, previousStarState);
              return next;
            });
          }

          console.error('[Sidebar] Failed to toggle session star:', error);
          alert(t('messages.updateSessionError', 'Failed to update session. Please try again.'));
        }
      });

    let trackedRequest: Promise<void>;
    trackedRequest = updateStar.finally(() => {
      const isCurrentRequest = sessionStarRequestQueueRef.current.get(sessionId) === trackedRequest;
      if (isCurrentRequest) {
        const latestRefresh = latestStarredRefreshRef.current;
        if (
          sessionStarToggleSequenceRef.current.get(sessionId) === latestSequence
          && latestRefresh?.kind === 'applied'
          && latestRefresh.sequence === starredSessionsFetchSequenceRef.current
        ) {
          // The accepted list is authoritative once the owning request settles.
          sessionStarStateRef.current.delete(sessionId);
          setOptimisticStarBySessionId((previous) => {
            if (!previous.has(sessionId)) {
              return previous;
            }

            const next = new Map(previous);
            next.delete(sessionId);
            return next;
          });
        }

        sessionStarRequestQueueRef.current.delete(sessionId);
      }
    });
    sessionStarRequestQueueRef.current.set(sessionId, trackedRequest);
  }, [fetchStarredSessions, starredSessionIds, t]);

  const toggleStarredSessionsOnly = useCallback(() => {
    const nextValue = !isStarredSessionsOnly;
    setIsStarredSessionsOnly(nextValue);
    writeStarredSessionsOnly(nextValue);
  }, [isStarredSessionsOnly]);

  /**
   * The fetched starred sessions with in-flight toggles applied.
   *
   * A session starred a moment ago is not in the fetched list yet, so its row
   * metadata is taken from the loaded project pages — which is exactly where
   * the star the user just clicked was rendered.
   */
  const resolvedStarredSessions = useMemo<StarredSessionListItem[]>(() => {
    if (optimisticStarBySessionId.size === 0) {
      return starredSessions;
    }

    const resolved = starredSessions.filter(
      (session) => optimisticStarBySessionId.get(session.sessionId) !== false,
    );
    const resolvedIds = new Set(resolved.map((session) => session.sessionId));

    for (const [sessionId, optimisticValue] of optimisticStarBySessionId.entries()) {
      if (!optimisticValue || resolvedIds.has(sessionId)) {
        continue;
      }

      for (const project of projects) {
        const loadedSession = (project.sessions ?? []).find(
          (session) => String(session.id) === sessionId,
        );
        if (!loadedSession) {
          continue;
        }

        const sessionTitle =
          typeof loadedSession.summary === 'string' && loadedSession.summary.trim().length > 0
            ? loadedSession.summary
            : typeof loadedSession.name === 'string' && loadedSession.name.trim().length > 0
              ? loadedSession.name
              : sessionId;

        resolved.push({
          sessionId,
          provider: loadedSession.__provider ?? loadedSession.provider ?? 'claude',
          projectId: project.projectId,
          projectPath: project.fullPath ?? project.path ?? null,
          projectDisplayName: project.displayName,
          sessionTitle,
          createdAt: loadedSession.createdAt ?? loadedSession.created_at ?? null,
          updatedAt: loadedSession.updated_at ?? null,
          lastActivity: loadedSession.lastActivity ?? null,
          isArchived: false,
          isProjectArchived: Boolean(project.isArchived),
          isOneShot: loadedSession.isOneShot === true,
        });
        break;
      }
    }

    return resolved;
  }, [optimisticStarBySessionId, projects, starredSessions]);

  const getProjectSessions = useCallback((project: Project) => getAllSessions(project), []);

  const loadMoreSessionsForProject = useCallback(async (projectId: string) => {
    if (!onLoadMoreSessions) {
      return;
    }

    let shouldLoad = false;
    setLoadingMoreProjects((previous) => {
      if (previous.has(projectId)) {
        return previous;
      }

      shouldLoad = true;
      const next = new Set(previous);
      next.add(projectId);
      return next;
    });

    if (!shouldLoad) {
      return;
    }

    try {
      await onLoadMoreSessions(projectId);
    } catch (error) {
      console.error('[Sidebar] Failed to load more sessions:', error);
      alert(t('messages.refreshError'));
    } finally {
      setLoadingMoreProjects((previous) => {
        const next = new Set(previous);
        next.delete(projectId);
        return next;
      });
    }
  }, [onLoadMoreSessions, t]);

  const projectsWithResolvedStarState = useMemo(() => {
    if (optimisticStarByProjectId.size === 0) {
      return projects;
    }

    return projects.map((project) => {
      const optimisticStarState = optimisticStarByProjectId.get(project.projectId);
      if (optimisticStarState === undefined) {
        return project;
      }

      const currentStarState = Boolean(project.isStarred);
      if (currentStarState === optimisticStarState) {
        return project;
      }

      return {
        ...project,
        isStarred: optimisticStarState,
      };
    });
  }, [optimisticStarByProjectId, projects]);

  const sortedProjects = useMemo(
    () => sortProjects(projectsWithResolvedStarState, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState],
  );

  const runningProjects = useMemo(() => {
    const projectsWithRunningSessions = buildRunningProjects(
      projectsWithResolvedStarState,
      runningSessionIds,
      recentWebSessions,
      projectSortOrder,
    );

    if (!isStarredSessionsOnly) {
      return projectsWithRunningSessions;
    }

    return projectsWithRunningSessions.reduce<Project[]>((acc, project) => {
      const sessions = (project.sessions ?? []).filter(
        (session) => starredSessionIds.has(String(session.id)),
      );
      if (sessions.length === 0) {
        return acc;
      }

      acc.push({
        ...project,
        sessions,
        sessionMeta: {
          ...project.sessionMeta,
          total: sessions.length,
          hasMore: false,
        },
      });
      return acc;
    }, []);
  }, [
    isStarredSessionsOnly,
    projectSortOrder,
    projectsWithResolvedStarState,
    recentWebSessions,
    runningSessionIds,
    starredSessionIds,
  ]);

  const starredProjects = useMemo(
    () => buildStarredProjects(projectsWithResolvedStarState, resolvedStarredSessions, projectSortOrder),
    [projectSortOrder, projectsWithResolvedStarState, resolvedStarredSessions],
  );

  const filteredProjects = useMemo(() => {
    const visibleProjects = searchMode === 'running'
      ? runningProjects
      : isStarredSessionsOnly
        ? starredProjects
        : sortedProjects;

    return filterProjects(visibleProjects, debouncedSearchQuery);
  }, [
    debouncedSearchQuery,
    isStarredSessionsOnly,
    runningProjects,
    searchMode,
    sortedProjects,
    starredProjects,
  ]);

  // With the filter on, the recents view lists the starred sessions themselves:
  // the paginated feed's pages would otherwise keep pulling in unstarred rows.
  const visibleRecentConversations = useMemo<RecentConversationListItem[]>(() => {
    if (!isStarredSessionsOnly) {
      return recentConversations;
    }

    return resolvedStarredSessions
      .filter((session) => !session.isArchived && !session.isProjectArchived && !session.isOneShot)
      .sort((sessionA, sessionB) => (sessionB.lastActivity ?? '').localeCompare(sessionA.lastActivity ?? ''))
      .map((session) => ({
        sessionId: session.sessionId,
        provider: session.provider,
        projectId: session.projectId,
        projectDisplayName: session.projectDisplayName,
        sessionTitle: session.sessionTitle,
        lastActivity: session.lastActivity,
        isOneShot: false,
      }));
  }, [isStarredSessionsOnly, recentConversations, resolvedStarredSessions]);

  const visibleConversationResults = useMemo<ConversationSearchResults | null>(() => {
    if (!isStarredSessionsOnly || !conversationResults) {
      return conversationResults;
    }

    const titleResults = conversationResults.titleResults.filter(
      (session) => starredSessionIds.has(session.sessionId),
    );
    let totalMatches = 0;
    const results = conversationResults.results.reduce<ConversationProjectResult[]>((acc, projectResult) => {
      const sessions = projectResult.sessions.filter(
        (session) => starredSessionIds.has(session.sessionId),
      );
      if (sessions.length === 0) {
        return acc;
      }

      for (const session of sessions) {
        totalMatches += session.matches.length;
      }
      acc.push({ ...projectResult, sessions });
      return acc;
    }, []);

    return { ...conversationResults, results, titleResults, totalMatches };
  }, [conversationResults, isStarredSessionsOnly, starredSessionIds]);

  // The archive holds starred sessions too, so the filter applies to both the
  // standalone rows and the sessions listed under an archived project.
  const starFilteredArchivedSessions = useMemo(() => {
    if (!isStarredSessionsOnly) {
      return archivedSessions;
    }

    return archivedSessions.filter((session) => starredSessionIds.has(session.sessionId));
  }, [archivedSessions, isStarredSessionsOnly, starredSessionIds]);

  const starFilteredArchivedProjects = useMemo(() => {
    if (!isStarredSessionsOnly) {
      return archivedProjects;
    }

    return archivedProjects.reduce<ArchivedProjectListItem[]>((acc, project) => {
      const sessions = (project.sessions ?? []).filter(
        (session) => starredSessionIds.has(String(session.id)),
      );
      if (sessions.length === 0) {
        return acc;
      }

      acc.push({
        ...project,
        sessions,
        sessionMeta: {
          ...project.sessionMeta,
          total: sessions.length,
          hasMore: false,
        },
      });
      return acc;
    }, []);
  }, [archivedProjects, isStarredSessionsOnly, starredSessionIds]);

  const filteredArchivedSessions = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return starFilteredArchivedSessions;
    }

    return starFilteredArchivedSessions.filter((session) => {
      const searchableFields = [
        session.sessionTitle,
        session.projectDisplayName,
        session.projectPath ?? '',
        session.provider,
      ];

      return searchableFields.some((value) => value.toLowerCase().includes(normalizedSearch));
    });
  }, [debouncedSearchQuery, starFilteredArchivedSessions]);

  const filteredArchivedProjects = useMemo(() => {
    const normalizedSearch = debouncedSearchQuery.trim().toLowerCase();
    if (!normalizedSearch) {
      return starFilteredArchivedProjects;
    }

    return starFilteredArchivedProjects.filter((project) => {
      const projectMatches = [
        project.displayName,
        project.fullPath || '',
      ].some((value) => value.toLowerCase().includes(normalizedSearch));

      if (projectMatches) {
        return true;
      }

      return getAllSessions(project).some((session) => {
        const sessionSummary =
          typeof session.summary === 'string' && session.summary.trim().length > 0
            ? session.summary
            : typeof session.name === 'string'
              ? session.name
              : '';

        return [
          sessionSummary,
          session.__provider,
        ].some((value) => value.toLowerCase().includes(normalizedSearch));
      });
    });
  }, [debouncedSearchQuery, starFilteredArchivedProjects]);

  // Keyed by projectId so the rename survives display-name mutations that arrive
  // while the input is open.
  const startEditingProject = useCallback((project: Project) => {
    setActiveRename({ target: 'project', id: project.projectId, draft: project.displayName });
  }, []);

  const startEditingSession = useCallback(
    (projectId: string, sessionId: string, initialName: string) => {
      setActiveRename({ target: 'session', id: sessionId, projectId, draft: initialName });
    },
    [],
  );

  const updateRenameDraft = useCallback((draft: string) => {
    setActiveRename((previous) => (previous ? { ...previous, draft } : previous));
  }, []);

  const cancelRename = useCallback(() => {
    setActiveRename(null);
  }, []);

  const saveProjectName = useCallback(
    // `projectId` is the DB primary key; the rename API resolves the path
    // through the `projects` table before writing the new display name.
    async (projectId: string, nextName: string) => {
      try {
        const response = await api.renameProject(projectId, nextName);
        if (response.ok) {
          await Promise.all([
            paletteOps.refreshProjects(),
            fetchStarredSessions(),
          ]);
        } else {
          console.error('Failed to rename project');
        }
      } catch (error) {
        console.error('Error renaming project:', error);
      } finally {
        setActiveRename(null);
      }
    },
    [fetchStarredSessions, paletteOps],
  );

  const showDeleteSessionConfirmation = useCallback(
    (
      sessionId: string,
      sessionTitle: string,
      options: { isArchived?: boolean } = {},
    ) => {
      setPendingDeletion({
        kind: 'session',
        sessionId,
        sessionTitle,
        isArchived: Boolean(options.isArchived),
      });
    },
    [],
  );

  const confirmDeleteSession = useCallback(async (hardDelete = false) => {
    if (pendingDeletion?.kind !== 'session') {
      return;
    }

    const { sessionId } = pendingDeletion;
    setPendingDeletion(null);

    try {
      const response = await api.deleteSession(sessionId, hardDelete);

      if (response.ok) {
        onSessionDelete?.(sessionId);
        await Promise.all([
          fetchArchivedSessions(),
          fetchStarredSessions(),
        ]);
      } else {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to delete session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.deleteSessionFailed'));
      }
    } catch (error) {
      console.error('[Sidebar] Error deleting session:', error);
      alert(t('messages.deleteSessionError'));
    }
  }, [fetchArchivedSessions, fetchStarredSessions, onSessionDelete, pendingDeletion, t]);

  const requestProjectDelete = useCallback(
    (project: Project) => {
      setPendingDeletion({
        kind: 'project',
        project,
        sessionCount: getProjectSessions(project).length,
      });
    },
    [getProjectSessions],
  );

  const confirmDeleteProject = useCallback(async (deleteData = false) => {
    if (pendingDeletion?.kind !== 'project') {
      return;
    }

    const { project } = pendingDeletion;

    setPendingDeletion(null);
    // Track in-flight deletes by projectId so the UI can disable actions
    // even if the project object is rebuilt while the request is flying.
    setDeletingProjects((prev) => new Set([...prev, project.projectId]));

    try {
      const response = await api.deleteProject(project.projectId, deleteData);

      if (response.ok) {
        onProjectDelete?.(project.projectId);
        await fetchStarredSessions();
      } else {
        const data = (await response.json()) as { error?: string | { message?: string } };
        const err = data.error;
        const message =
          typeof err === 'string' ? err : err && typeof err === 'object' && err.message ? err.message : t('messages.deleteProjectFailed');
        alert(message);
      }
    } catch (error) {
      console.error('Error deleting project:', error);
      alert(t('messages.deleteProjectError'));
    } finally {
      setDeletingProjects((prev) => {
        const next = new Set(prev);
        next.delete(project.projectId);
        return next;
      });
    }
  }, [fetchStarredSessions, pendingDeletion, onProjectDelete, t]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      onProjectSelect(project);
      setCurrentProject(project);
    },
    [onProjectSelect, setCurrentProject],
  );
  const handleNewSession = useCallback(
    (project: Project) => {
      setCurrentProject(project);
      onNewSession(project);
    },
    [onNewSession, setCurrentProject],
  );

  const openArchivedSession = useCallback((session: ArchivedSessionListItem) => {
    const activeProject = session.projectId
      ? projects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const archivedProject = session.projectId
      ? archivedProjects.find((candidate) => candidate.projectId === session.projectId)
      : null;
    const matchingProject = activeProject ?? archivedProject ?? null;
    const sessionPayload: ProjectSession = {
      id: session.sessionId,
      summary: session.sessionTitle,
      __provider: session.provider,
      __projectId: matchingProject?.projectId ?? session.projectId ?? undefined,
    };

    // Archived sessions still need a selected project context. Active projects
    // come from the normal sidebar list, while archived-project sessions resolve
    // through the archive payload loaded by this controller.
    if (matchingProject) {
      handleProjectSelect(matchingProject);
    }

    onSessionSelect(sessionPayload);
  }, [archivedProjects, handleProjectSelect, onSessionSelect, projects]);

  const restoreArchivedProject = useCallback(async (projectId: string) => {
    try {
      const response = await api.restoreProject(projectId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore project:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreProjectFailed', 'Failed to restore project. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
        fetchStarredSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring project:', error);
      alert(t('messages.restoreProjectError', 'Error restoring project. Please try again.'));
    }
  }, [fetchArchivedSessions, fetchStarredSessions, onRefresh, t]);

  const restoreArchivedSession = useCallback(async (sessionId: string) => {
    try {
      const response = await api.restoreSession(sessionId);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('[Sidebar] Failed to restore session:', {
          status: response.status,
          error: errorText,
        });
        alert(t('messages.restoreSessionFailed', 'Failed to restore session. Please try again.'));
        return;
      }

      await Promise.all([
        Promise.resolve(onRefresh()),
        fetchArchivedSessions(),
        fetchStarredSessions(),
      ]);
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      alert(t('messages.restoreSessionError', 'Error restoring session. Please try again.'));
    }
  }, [fetchArchivedSessions, fetchStarredSessions, onRefresh, t]);

  const refreshProjects = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const refreshedSessionIds = await refreshRunningSessions();
      await Promise.all([
        Promise.resolve(onRefresh()),
        onHydrateRunningSessions(refreshedSessionIds ?? runningSessionIds),
        fetchArchivedSessions(),
        fetchStarredSessions(),
        searchMode === 'conversations'
          ? fetchRecentConversationsPage(0, false)
          : Promise.resolve(),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  }, [
    fetchArchivedSessions,
    fetchStarredSessions,
    fetchRecentConversationsPage,
    onHydrateRunningSessions,
    onRefresh,
    refreshRunningSessions,
    runningSessionIds,
    searchMode,
  ]);

  const updateSessionSummary = useCallback(
    // `_projectId` and `_provider` are preserved for compatibility with
    // existing sidebar callback signatures; backend rename only needs sessionId.
    async (_projectId: string, sessionId: string, summary: string, _provider: LLMProvider) => {
      const trimmed = summary.trim();
      if (!trimmed) {
        setActiveRename(null);
        return;
      }
      try {
        const response = await api.renameSession(sessionId, trimmed);
        if (response.ok) {
          await Promise.all([
            onRefresh(),
            fetchStarredSessions(),
          ]);
        } else {
          console.error('[Sidebar] Failed to rename session:', response.status);
          alert(t('messages.renameSessionFailed'));
        }
      } catch (error) {
        console.error('[Sidebar] Error renaming session:', error);
        alert(t('messages.renameSessionError'));
      } finally {
        setActiveRename(null);
      }
    },
    [fetchStarredSessions, onRefresh, t],
  );

  /**
   * Branches a session and opens the copy.
   *
   * The new row arrives over the websocket as a `session_upserted`, so nothing
   * is refetched here — the sidebar already has it by the time this navigates.
   */
  const forkSession = useCallback(
    async (session: SessionWithProvider) => {
      try {
        const response = await api.forkSession(session.id);
        const payload = await response.json();
        const forkedSessionId = payload?.data?.sessionId;
        if (!response.ok || typeof forkedSessionId !== 'string') {
          throw new Error(payload?.message || `HTTP ${response.status}`);
        }

        onSessionSelect({
          id: forkedSessionId,
          summary: payload.data.sessionName,
          __provider: session.__provider,
          __projectId: session.__projectId,
        } as ProjectSession);
      } catch (error) {
        console.error('[Sidebar] Error forking session:', error);
        alert(t('messages.forkSessionError'));
      }
    },
    [onSessionSelect, t],
  );

  const collapseSidebar = useCallback(() => {
    setSidebarVisible(false);
  }, [setSidebarVisible]);

  const expandSidebar = useCallback(() => {
    setSidebarVisible(true);
  }, [setSidebarVisible]);

  return {
    isSidebarCollapsed,
    isProjectExpanded,
    activeRename,
    showNewProject,
    initialSessionsLoaded,
    currentTime,
    isRefreshing,
    searchFilter,
    deletingProjects,
    loadingMoreProjects,
    pendingDeletion,
    showVersionModal,
    filteredProjects,
    runningSessionsCount,
    archivedProjects: filteredArchivedProjects,
    archivedSessions: filteredArchivedSessions,
    archivedSessionsCount: starFilteredArchivedProjects.length + starFilteredArchivedSessions.length,
    isArchivedSessionsLoading,
    recentConversations: visibleRecentConversations,
    recentConversationsTotal: isStarredSessionsOnly ? visibleRecentConversations.length : recentConversationsTotal,
    // Pagination and the error/loading states belong to the recents feed, which
    // the starred filter replaces outright.
    recentConversationsHasMore: isStarredSessionsOnly ? false : recentConversationsHasMore,
    isRecentConversationsLoading: isStarredSessionsOnly ? false : isRecentConversationsLoading,
    isLoadingMoreRecentConversations,
    recentConversationsError: isStarredSessionsOnly ? false : recentConversationsError,
    reloadRecentConversations,
    loadMoreRecentConversations,
    toggleProject,
    handleSessionClick,
    forkSession,
    toggleStarProject,
    isProjectStarred,
    isSessionStarred,
    toggleStarSession,
    isStarredSessionsOnly,
    toggleStarredSessionsOnly,
    isStarredSessionsLoading,
    starredSessionsError,
    starredSessionsLoaded,
    getProjectSessions,
    loadMoreSessionsForProject,
    startEditingProject,
    startEditingSession,
    updateRenameDraft,
    cancelRename,
    saveProjectName,
    showDeleteSessionConfirmation,
    confirmDeleteSession,
    requestProjectDelete,
    confirmDeleteProject,
    handleProjectSelect,
    handleNewSession,
    openArchivedSession,
    restoreArchivedProject,
    restoreArchivedSession,
    refreshProjects,
    updateSessionSummary,
    collapseSidebar,
    expandSidebar,
    setShowNewProject,
    searchMode,
    setSearchMode,
    conversationResults: visibleConversationResults,
    isSearching,
    searchProgress,
    clearConversationResults: useCallback(() => {
      searchSeqRef.current += 1;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setIsSearching(false);
      setSearchProgress(null);
      setConversationResults(null);
    }, []),
    setSearchFilter,
    setPendingDeletion,
    setShowVersionModal,
  };
}
