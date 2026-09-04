import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { api } from '@/shared/api';
import type { MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { findSearchTargetIndex, resolveSearchWindowSize } from '@/modules/chat/utils/searchTargetLocator';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { SearchTarget } from '@/modules/chat/utils/searchTargetLocator';

type UserTurnDirection = 'previous' | 'next';

const USER_TURN_ALIGNMENT_TOLERANCE = 8;

function findAdjacentUserTurn(
  container: HTMLDivElement,
  direction: UserTurnDirection,
  currentTarget: HTMLElement | null,
): HTMLElement | null {
  const containerBounds = container.getBoundingClientRect();
  const userTurns = Array.from(container.querySelectorAll<HTMLElement>('[data-user-turn]'));

  if (currentTarget?.isConnected) {
    const currentIndex = userTurns.indexOf(currentTarget);
    const currentBounds = currentTarget.getBoundingClientRect();
    const targetStillVisible = (
      currentBounds.bottom >= containerBounds.top
      && currentBounds.top <= containerBounds.bottom
    );
    if (currentIndex >= 0 && targetStillVisible) {
      const targetIndex = currentIndex + (direction === 'next' ? 1 : -1);
      return userTurns[targetIndex] ?? null;
    }
  }

  const containerCenter = containerBounds.top + containerBounds.height / 2;
  if (direction === 'next') {
    for (const userTurn of userTurns) {
      const bounds = userTurn.getBoundingClientRect();
      if (bounds.top + bounds.height / 2 > containerCenter + USER_TURN_ALIGNMENT_TOLERANCE) {
        return userTurn;
      }
    }
    return null;
  }

  for (let index = userTurns.length - 1; index >= 0; index -= 1) {
    const userTurn = userTurns[index];
    const bounds = userTurn.getBoundingClientRect();
    if (bounds.top + bounds.height / 2 < containerCenter - USER_TURN_ALIGNMENT_TOLERANCE) {
      return userTurn;
    }
  }
  return null;
}

function findPreviousUserTurnIndex(messages: readonly ChatMessage[], beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    if (messages[index].type === 'user') {
      return index;
    }
  }
  return -1;
}

function waitForChatLayout(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });
}

const INITIAL_VISIBLE_MESSAGES = 100;

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used.
 */
const SEARCH_SCROLL_RETRIES = 20;
const SEARCH_SCROLL_RETRY_DELAY_MS = 150;

/**
 * Finds the rendered row for a resolved search target.
 *
 * Only an exact timestamp match counts while retries remain: the widened window
 * may not be committed yet, and accepting the nearest row then would scroll to
 * an arbitrary message and flash the highlight on it — the silent wrong answer
 * this rewrite exists to remove. `allowNearest` is used on the final attempt
 * because a hit on the second or later call of a collapsed tool group has no row
 * of its own; groupConsecutiveTools stamps the group with the run's FIRST
 * timestamp, so the group row is the nearest, not an exact, match.
 */
function findRenderedMessageElement(
  container: HTMLElement,
  timestamp: unknown,
  allowNearest: boolean,
): HTMLElement | null {
  const targetTimestamp = String(timestamp);
  const targetTime = new Date(targetTimestamp).getTime();
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-timestamp]');

  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.getAttribute('data-message-timestamp');
    if (!candidateTimestamp) {
      continue;
    }
    if (candidateTimestamp === targetTimestamp) {
      return candidate;
    }

    if (!allowNearest) {
      continue;
    }

    const candidateTime = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)) {
      continue;
    }

    const distance = Math.abs(candidateTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return nearest;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  /**
   * Accepted and ignored: the streaming buffers now live in the chat pane, so
   * this hook no longer resets them. Callers that still pass it keep compiling.
   */
  resetStreamingState?: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
};

type ScrollRestoreState = {
  height: number;
  top: number;
  anchor: HTMLElement | null;
  anchorOffset: number | null;
};

function captureScrollRestoreState(container: HTMLDivElement): ScrollRestoreState {
  const containerBounds = container.getBoundingClientRect();
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('.chat-message'))
    .find((element) => element.getBoundingClientRect().bottom >= containerBounds.top)
    ?? null;

  return {
    height: container.scrollHeight,
    top: container.scrollTop,
    anchor,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - containerBounds.top
      : null,
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUpState] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [navigatingUserTurn, setNavigatingUserTurn] = useState<UserTurnDirection | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const wasNearTopRef = useRef(false);
  // The sidebar-search hit this transcript still owes the user a scroll to.
  // State rather than a ref because resolving it widens the render window,
  // and it is cleared once the row is on screen or the retries run out.
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchScrollActiveRef = useRef(false);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Scroll ownership is mirrored synchronously so a wheel or touch gesture can
   * beat layout effects scheduled by the same render.
   */
  const isUserScrolledUpRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollRestoreState | null>(null);
  const messagesOffsetRef = useRef(0);
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  // The last socket that carried this session's subscription. A new identity
  // marks reconnect so the persisted-tail refresh can follow the subscribe.
  const subscribedSocketRef = useRef<WebSocket | null>(null);
  const transcriptGenerationRef = useRef(0);
  const transcriptIdentityRef = useRef<string | null>(null);
  const transcriptIdentity = `${selectedProject?.projectId ?? ''}:${selectedSession?.id ?? ''}`;
  if (transcriptIdentityRef.current !== transcriptIdentity) {
    transcriptIdentityRef.current = transcriptIdentity;
    transcriptGenerationRef.current += 1;
    isLoadingMoreRef.current = false;
    isUserScrolledUpRef.current = false;
  }
  const transcriptGeneration = transcriptGenerationRef.current;
  const navigatingUserTurnRef = useRef<UserTurnDirection | null>(null);
  const visibleMessageCountRef = useRef(visibleMessageCount);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const scrollNavigationGenerationRef = useRef(0);
  const sessionRequestGenerationRef = useRef(0);
  const navigationProjectRef = useRef<string | null>(null);
  const navigationSessionRef = useRef<string | null>(null);
  const lastNavigatedUserTurnRef = useRef<HTMLElement | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> ProjectWorkspaceRoute -> WorkspaceMain -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, pagination/scroll bookkeeping,
     *   and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    scrollNavigationGenerationRef.current += 1;
    sessionRequestGenerationRef.current += 1;
    navigatingUserTurnRef.current = null;
    setNavigatingUserTurn(null);
    lastNavigatedUserTurnRef.current = null;
    isLoadingMoreRef.current = false;
    setIsLoadingMoreMessages(false);
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    setIsLoadingMoreMessages(false);
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  if (
    navigationSessionRef.current !== activeSessionId
    || navigationProjectRef.current !== (selectedProject?.projectId ?? null)
  ) {
    navigationSessionRef.current = activeSessionId;
    navigationProjectRef.current = selectedProject?.projectId ?? null;
    scrollNavigationGenerationRef.current += 1;
    sessionRequestGenerationRef.current += 1;
  }

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const ownsTranscript = useCallback((
    generation: number,
    identity: string,
    sessionId: string,
  ) => (
    generation === transcriptGenerationRef.current
    && identity === transcriptIdentityRef.current
    && activeSessionIdRef.current === sessionId
  ), []);

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const requestGeneration = transcriptGenerationRef.current;
    const requestIdentity = transcriptIdentityRef.current ?? '';
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => ownsTranscript(requestGeneration, requestIdentity, sessionId),
    });
    const slot = result.slot;
    if (slot && ownsTranscript(requestGeneration, requestIdentity, sessionId)) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    return all;
  }, [storeMessages, pendingUserMessage]);

  visibleMessageCountRef.current = visibleMessageCount;
  chatMessagesRef.current = chatMessages;

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const setIsUserScrolledUp = useCallback((next: boolean) => {
    isUserScrolledUpRef.current = next;
    setIsUserScrolledUpState(next);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const scrollToBottomAndReset = useCallback(() => {
    scrollNavigationGenerationRef.current += 1;
    navigatingUserTurnRef.current = null;
    setNavigatingUserTurn(null);
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
    pendingScrollRestoreRef.current = null;
    lastNavigatedUserTurnRef.current = null;
    isUserScrolledUpRef.current = false;
    setIsUserScrolledUp(false);
    scrollToBottom();
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    const { scrollTop, scrollHeight, clientHeight } = container;
    return scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  const handleUserScrollGesture = useCallback(() => {
    if (transcriptGeneration !== transcriptGenerationRef.current) return;
    setIsUserScrolledUp(true);
  }, [setIsUserScrolledUp, transcriptGeneration]);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement, canApply?: () => boolean) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;
      const requestSessionId = selectedSession.id;
      const requestSessionGeneration = sessionRequestGenerationRef.current;
      const requestScrollGeneration = scrollNavigationGenerationRef.current;

      const requestGeneration = transcriptGeneration;
      const requestIdentity = transcriptIdentity;
      if (!ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) return false;

      isLoadingMoreRef.current = true;
      setIsLoadingMoreMessages(true);
      const scrollRestoreState = captureScrollRestoreState(container);

      try {
        const result = await sessionStore.fetchMore(requestSessionId, {
          limit: 80,
          canRequest: () => (
            ownsTranscript(requestGeneration, requestIdentity, requestSessionId)
            && isActiveRef.current
            && activeSessionIdRef.current === requestSessionId
            && sessionRequestGenerationRef.current === requestSessionGeneration
            && scrollNavigationGenerationRef.current === requestScrollGeneration
            && (!canApply || canApply())
          ),
        });
        if (
          !ownsTranscript(requestGeneration, requestIdentity, requestSessionId)
          || !isActiveRef.current
          || activeSessionIdRef.current !== requestSessionId
          || sessionRequestGenerationRef.current !== requestSessionGeneration
          || scrollNavigationGenerationRef.current !== requestScrollGeneration
          || (canApply && !canApply())
        ) {
          return false;
        }
        const { slot, prependedCount } = result;
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }

        if (prependedCount === 0) {
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
          }
          return false;
        }

        pendingScrollRestoreRef.current = scrollRestoreState;
        setVisibleMessageCount((prev) => prev + prependedCount);
        if (!slot.hasMore) {
          allMessagesLoadedRef.current = true;
          setAllMessagesLoaded(true);
          if (loadAllOverlayTimerRef.current) {
            clearTimeout(loadAllOverlayTimerRef.current);
            loadAllOverlayTimerRef.current = null;
          }
          setShowLoadAllOverlay(false);
        }
        return true;
      } finally {
        if (
          ownsTranscript(requestGeneration, requestIdentity, requestSessionId)
          && activeSessionIdRef.current === requestSessionId
          && sessionRequestGenerationRef.current === requestSessionGeneration
          && scrollNavigationGenerationRef.current === requestScrollGeneration
        ) {
          isLoadingMoreRef.current = false;
          setIsLoadingMoreMessages(false);
        }
      }
    },
    [
      hasMoreMessages,
      isActive,
      isLoadingMoreMessages,
      ownsTranscript,
      selectedProject,
      selectedSession,
      sessionStore,
      transcriptGeneration,
      transcriptIdentity,
    ],
  );

  const navigateUserTurn = useCallback(async (direction: UserTurnDirection) => {
    const container = scrollContainerRef.current;
    const requestSessionId = activeSessionIdRef.current;
    if (!container || navigatingUserTurnRef.current) return;

    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);

    const requestGeneration = scrollNavigationGenerationRef.current + 1;
    scrollNavigationGenerationRef.current = requestGeneration;
    const isCurrentNavigation = () => (
      isActiveRef.current
      && activeSessionIdRef.current === requestSessionId
      && scrollNavigationGenerationRef.current === requestGeneration
      && scrollContainerRef.current === container
    );

    navigatingUserTurnRef.current = direction;
    setNavigatingUserTurn(direction);
    isUserScrolledUpRef.current = true;
    setIsUserScrolledUp(true);

    try {
      let target = findAdjacentUserTurn(container, direction, lastNavigatedUserTurnRef.current);

      while (!target && direction === 'previous' && isCurrentNavigation()) {
        const messages = chatMessagesRef.current;
        const visibleStart = Math.max(0, messages.length - visibleMessageCountRef.current);
        const olderTurnIndex = findPreviousUserTurnIndex(messages, visibleStart);

        if (olderTurnIndex >= 0) {
          pendingScrollRestoreRef.current = captureScrollRestoreState(container);
          const requiredVisibleCount = messages.length - olderTurnIndex;
          setVisibleMessageCount((current) => Math.max(current, requiredVisibleCount));
        } else {
          const loaded = await loadOlderMessages(container, isCurrentNavigation);
          if (!loaded) break;
        }

        await waitForChatLayout();
        if (!isCurrentNavigation()) break;
        target = findAdjacentUserTurn(container, direction, lastNavigatedUserTurnRef.current);
      }

      if (!target || !target.isConnected || !isCurrentNavigation()) return;

      pendingScrollRestoreRef.current = null;
      target.scrollIntoView({ behavior: 'auto', block: 'center' });
      await waitForChatLayout();
      if (target.isConnected && isCurrentNavigation()) {
        target.scrollIntoView({ behavior: 'auto', block: 'center' });
        lastNavigatedUserTurnRef.current = target;
      }
    } finally {
      if (scrollNavigationGenerationRef.current === requestGeneration) {
        navigatingUserTurnRef.current = null;
        setNavigatingUserTurn(null);
        const userScrolledUp = !isNearBottom();
        isUserScrolledUpRef.current = userScrolledUp;
        setIsUserScrolledUp(userScrolledUp);
      }
    }
  }, [isNearBottom, loadOlderMessages]);

  const handleScroll = useCallback(async () => {
    if (!isActive || transcriptGeneration !== transcriptGenerationRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom();
    setIsUserScrolledUp(!nearBottom);
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad && transcriptGeneration === transcriptGenerationRef.current) {
        topLoadLockRef.current = true;
      }
    }
  }, [
    hasMoreMessages,
    isActive,
    isNearBottom,
    loadOlderMessages,
    setIsUserScrolledUp,
    transcriptGeneration,
  ]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    if (!isActive || !scrollContainerRef.current) return;

    const container = scrollContainerRef.current;
    if (pendingScrollRestoreRef.current) {
      const { height, top, anchor, anchorOffset } = pendingScrollRestoreRef.current;
      if (anchor?.isConnected && anchorOffset !== null) {
        const nextAnchorOffset = (
          anchor.getBoundingClientRect().top
          - container.getBoundingClientRect().top
        );
        container.scrollTop += nextAnchorOffset - anchorOffset;
      } else {
        container.scrollTop = top + Math.max(container.scrollHeight - height, 0);
      }
      pendingScrollRestoreRef.current = null;
      return;
    }

    if (becameActive) {
      container.scrollTop = isUserScrolledUpRef.current
        ? scrollPositionRef.current.top
        : container.scrollHeight;
    }
  }, [
    chatMessages.length,
    isActive,
    isUserScrolledUp,
    transcriptGeneration,
    visibleMessageCount,
  ]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);
    scrollNavigationGenerationRef.current += 1;
    navigatingUserTurnRef.current = null;
    setNavigatingUserTurn(null);
    lastNavigatedUserTurnRef.current = null;
    isLoadingMoreRef.current = false;
    setIsLoadingMoreMessages(false);

    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setIsLoadingMoreMessages(false);
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    wasNearTopRef.current = false;
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id, setIsUserScrolledUp]);

  // This is the only owner of chat.subscribe. On reconnect the subscription
  // goes first so the server attaches and replays missed seq frames before a
  // persisted-tail refresh can merge the completed part of the turn.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    const isReconnect = subscribedSocketRef.current !== null
      && subscribedSocketRef.current !== ws;
    subscribedSocketRef.current = ws;
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
    if (isReconnect) {
      void requestLatestMessages(selectedSession.id, isActive);
    }
  }, [
    isActive,
    lastSeqRef,
    requestLatestMessages,
    selectedProject,
    selectedSession,
    sendMessage,
    statusCheckSentAtRef,
    ws,
  ]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    const requestGeneration = transcriptGeneration;
    const requestIdentity = transcriptIdentity;
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => ownsTranscript(requestGeneration, requestIdentity, selectedSessionId),
    }).then(slot => {
      if (!ownsTranscript(requestGeneration, requestIdentity, selectedSessionId)) return;
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      if (ownsTranscript(requestGeneration, requestIdentity, selectedSessionId)) {
        setIsLoadingSessionMessages(false);
      }
    });
  }, [
    isActive,
    ownsTranscript,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
    transcriptGeneration,
    transcriptIdentity,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming. The shared transcript
        // layout effect owns any bottom follow after the refresh commits.
        if (!isProcessing) {
          await requestLatestMessages(selectedSession.id);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    const requestTranscriptGeneration = transcriptGeneration;
    const requestIdentity = transcriptIdentity;
    const requestSessionId = activeSessionIdRef.current;
    setSearchTarget(null);
    const requestScrollGeneration = scrollNavigationGenerationRef.current + 1;
    scrollNavigationGenerationRef.current = requestScrollGeneration;
    navigatingUserTurnRef.current = null;
    setNavigatingUserTurn(null);
    lastNavigatedUserTurnRef.current = null;

    const isCurrentSearch = () => (
      isActiveRef.current
      && activeSessionIdRef.current === requestSessionId
      && scrollNavigationGenerationRef.current === requestScrollGeneration
    );

    const scrollToTarget = async () => {
      if (
        !requestSessionId
        || !ownsTranscript(requestTranscriptGeneration, requestIdentity, requestSessionId)
      ) {
        return;
      }
      if (!allMessagesLoadedRef.current && selectedProject) {
        try {
          // Load all messages into the store for search navigation
          const slot = await sessionStore.fetchFromServer(requestSessionId, {
            limit: null,
            offset: 0,
            canRequest: () => (
              ownsTranscript(requestTranscriptGeneration, requestIdentity, requestSessionId)
              && isCurrentSearch()
            ),
          });
          if (
            !ownsTranscript(requestTranscriptGeneration, requestIdentity, requestSessionId)
            || !isCurrentSearch()
          ) return;
          if (slot) {
            // Fetch the whole transcript so an old hit can be found, but do
            // not render all of it — the window below is widened to exactly
            // what the resolved target needs.
            setHasMoreMessages(false);
            setTotalMessages(slot.total);
            messagesOffsetRef.current = slot.offset;
            setAllMessagesLoaded(true);
            allMessagesLoadedRef.current = true;
          } else if (!isActiveRef.current) {
            setSearchTarget(target);
            return;
          }
        } catch {
          // Fall through and scroll in current messages
        }
      }
      if (
        !ownsTranscript(requestTranscriptGeneration, requestIdentity, requestSessionId)
        || !isCurrentSearch()
      ) return;
      // Resolve the target against the loaded transcript rather than the DOM.
      // The store is the freshest source here: the `fetchFromServer` above has
      // landed but `chatMessages` is from the render that scheduled this effect.
      const messagesForSearch = normalizedToChatMessages(
        sessionStore.getMessages(requestSessionId),
      );
      const targetIndex = findSearchTargetIndex(messagesForSearch, target);
      if (targetIndex < 0) {
        // The target is not in the transcript at all. Scrolling somewhere
        // plausible would claim a hit that does not exist.
        searchScrollActiveRef.current = false;
        return;
      }

      // Widen the window so the target is rendered. `visibleMessages` is a tail
      // slice, so covering index N means rendering everything after it.
      const requiredVisibleCount = resolveSearchWindowSize(
        messagesForSearch.length,
        targetIndex,
        SEARCH_TARGET_CONTEXT_MESSAGES,
      );
      setVisibleMessageCount((previous) => Math.max(previous, requiredVisibleCount));

      const targetTimestamp = messagesForSearch[targetIndex].timestamp;

      const scrollToRenderedTarget = (retriesLeft: number) => {
        if (
          !ownsTranscript(requestTranscriptGeneration, requestIdentity, requestSessionId)
        ) return;
        const container = scrollContainerRef.current;
        if (!isCurrentSearch()) {
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }
        if (!container) return;

        // The target is inside the window by construction, so this only waits
        // for React to commit the widened list. A target collapsed inside a
        // tool group resolves to that group, which carries the same timestamp.
        const targetElement = findRenderedMessageElement(
          container,
          targetTimestamp,
          retriesLeft === 0,
        );

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }

        if (retriesLeft > 0) {
          searchScrollTimerRef.current = setTimeout(
            () => scrollToRenderedTarget(retriesLeft - 1),
            SEARCH_SCROLL_RETRY_DELAY_MS,
          );
          return;
        }

        searchScrollTimerRef.current = null;
        searchScrollActiveRef.current = false;
      };

      searchScrollTimerRef.current = setTimeout(
        () => scrollToRenderedTarget(SEARCH_SCROLL_RETRIES),
        150,
      );
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }

    const requestSessionId = selectedSession.id;
    const requestGeneration = transcriptGeneration;
    const requestIdentity = transcriptIdentity;
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const response = await api.providers.sessionTokenUsage(requestSessionId);
        if (!ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) return;
        if (response.ok) {
          const payload = await response.json();
          if (ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) {
            setTokenBudget(payload.data ?? null);
          }
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [
    ownsTranscript,
    selectedSession?.id,
    transcriptGeneration,
    transcriptIdentity,
  ]);

  const visibleMessages = useMemo(() => {
    if (chatMessages.length <= visibleMessageCount) return chatMessages;
    return chatMessages.slice(-visibleMessageCount);
  }, [chatMessages, visibleMessageCount]);

  useEffect(() => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    scrollPositionRef.current = { height: container.scrollHeight, top: container.scrollTop };
  });

  useLayoutEffect(() => {
    if (!isActive || isLoadingSessionMessages) return;
    if (!scrollContainerRef.current || chatMessages.length === 0) return;
    if (isLoadingMoreRef.current || isLoadingMoreMessages || pendingScrollRestoreRef.current) return;
    if (searchScrollActiveRef.current || isUserScrolledUpRef.current) return;

    scrollToBottom();
  }, [
    chatMessages,
    isActive,
    isLoadingMoreMessages,
    isLoadingSessionMessages,
    scrollToBottom,
    transcriptGeneration,
  ]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    const requestGeneration = transcriptGeneration;
    const requestIdentity = transcriptIdentity;
    if (!ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) return;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;
    const scrollRestoreState = container ? captureScrollRestoreState(container) : null;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => ownsTranscript(requestGeneration, requestIdentity, requestSessionId),
      });

      if (!ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) return;

      if (slot) {
        if (scrollRestoreState) {
          pendingScrollRestoreRef.current = scrollRestoreState;
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      if (ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) {
        console.error('Error loading all messages:', error);
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } finally {
      if (ownsTranscript(requestGeneration, requestIdentity, requestSessionId)) {
        isLoadingMoreRef.current = false;
        setIsLoadingAllMessages(false);
      }
    }
  }, [
    isActive,
    isLoadingAllMessages,
    ownsTranscript,
    selectedProject,
    selectedSession,
    sessionStore,
    transcriptGeneration,
    transcriptIdentity,
  ]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    return normalizedToChatMessages(sessionStore.getMessages(sessionId));
  }, [sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    handleUserScrollGesture,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    requestLatestMessages,
    navigateUserTurn,
    navigatingUserTurn,
  };
}
