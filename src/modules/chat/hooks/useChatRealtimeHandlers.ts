import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent,MarkSessionIdle,MarkSessionProcessing,PendingPermissionRequest,ProjectSession,LLMProvider,NormalizedMessage } from '@/shared/types';
import { showCompletionTitleIndicator } from '@/modules/chat/utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '@/shared/utils';
import { streamingMessageId } from '@/modules/chat/hooks/useSessionStore';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

const isActionablePermissionRequest = (request: { toolName?: unknown } | null | undefined): boolean => {
  return request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
};

const hasActionablePermissionRequests = (requests: Array<{ toolName?: unknown }> | null | undefined): boolean => {
  return Array.isArray(requests) && requests.some((request) => isActionablePermissionRequest(request));
};
const FLUSH_INTERVAL_MS = 100;

type BufferedRow = {
  id: string;
  text: string;
  provider: LLMProvider;
  timestamp: string;
  seq: number | null;
  dirty: boolean;
  lastFrameAt: number;
};

type SessionBuffers = {
  get: (sessionId: string) => BufferedRow | undefined;
  append: (
    sessionId: string,
    text: string,
    provider: LLMProvider,
    timestamp: string,
    seq: number | null,
    mintId: () => string,
  ) => void;
  close: (sessionId: string) => BufferedRow | undefined;
  drop: (sessionId: string) => BufferedRow | undefined;
  stopTimer: () => void;
};

/**
 * Coalesces one streamed surface without sharing state between sessions.
 * Rows outlive websocket-listener re-subscriptions; only the timer is effect-scoped.
 */
function createSessionBuffers(write: (sessionId: string, row: BufferedRow) => void): SessionBuffers {
  const rows = new Map<string, BufferedRow>();
  let timer: number | null = null;

  const flush = (onlySessionId?: string) => {
    for (const [sessionId, row] of rows) {
      if ((onlySessionId && sessionId !== onlySessionId) || !row.dirty) continue;
      row.dirty = false;
      write(sessionId, row);
    }
  };

  return {
    get: sessionId => rows.get(sessionId),
    append(sessionId, text, provider, timestamp, seq, mintId) {
      let row = rows.get(sessionId);
      if (!row) {
        row = {
          id: mintId(),
          text: '',
          provider,
          timestamp,
          seq,
          dirty: false,
          lastFrameAt: 0,
        };
        rows.set(sessionId, row);
      }
      row.text += text;
      row.timestamp = timestamp;
      row.seq = seq;
      row.dirty = true;
      row.lastFrameAt = Date.now();
      if (timer === null) {
        timer = window.setTimeout(() => {
          timer = null;
          flush();
        }, FLUSH_INTERVAL_MS);
      }
    },
    close(sessionId) {
      const row = rows.get(sessionId);
      if (!row) return undefined;
      flush(sessionId);
      rows.delete(sessionId);
      return row;
    },
    drop(sessionId) {
      const row = rows.get(sessionId);
      rows.delete(sessionId);
      return row;
    },
    stopTimer() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      flush();
    },
  };
}


type UseChatRealtimeHandlersArgs = {
  isActive: boolean;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  /**
   * Highest live `seq` observed per session. Essential for reconnect catch-up:
   * `chat.subscribe` sends this value as `lastSeq` so the server replays only
   * the events this client actually missed. Written here on every sequenced
   * frame; read wherever a `chat.subscribe` is sent (session open, reconnect).
   */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  requestLatestMessages: (sessionId: string, allowNetwork?: boolean) => Promise<void>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

/**
 * Routes server events into the session store and processing-state map.
 *
 * This is intentionally a thin reducer over the unified `kind`-based
 * protocol: every frame is keyed by the stable app session id, so there is
 * no session-id handoff, no provider branching, and no navigation here.
 * Sidebar events (`session_upserted`, `loading_progress`) are handled by
 * `useProjectsState`, not in this hook.
 */
export function useChatRealtimeHandlers({
  isActive,
  subscribe,
  provider,
  selectedSession,
  currentSessionId,
  setTokenBudget,
  pendingPermissionRequests,
  setPendingPermissionRequests,
  lastSeqRef,
  statusCheckSentAtRef,
  onSessionProcessing,
  onSessionIdle,
  onWebSocketReconnect,
  requestLatestMessages,
  sessionStore,
}: UseChatRealtimeHandlersArgs) {
  // Session switches can send `chat.subscribe` before this effect has a chance
  // to rebind the websocket listener. Read the visible session id from a ref
  // so a fast `chat_subscribed` ack is matched against the current view, not
  // the previous render's closed-over selection.
  const activeViewSessionIdRef = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  activeViewSessionIdRef.current = selectedSession?.id || currentSessionId || null;
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const sessionStoreRef = useRef(sessionStore);
  sessionStoreRef.current = sessionStore;

  const thinkingBuffersRef = useRef<SessionBuffers | null>(null);
  if (!thinkingBuffersRef.current) {
    thinkingBuffersRef.current = createSessionBuffers((sessionId, row) => {
      sessionStoreRef.current.updateThinking(
        sessionId,
        row.id,
        row.text,
        row.provider,
        row.timestamp,
      );
    });
  }
  const thinkingBuffers = thinkingBuffersRef.current;

  const streamBuffersRef = useRef<SessionBuffers | null>(null);
  if (!streamBuffersRef.current) {
    streamBuffersRef.current = createSessionBuffers((sessionId, row) => {
      sessionStoreRef.current.updateStreaming(
        sessionId,
        row.text,
        row.provider,
        row.timestamp,
      );
    });
  }
  const streamBuffers = streamBuffersRef.current;
  const thinkingBlockSeqRef = useRef(0);

  const endStream = useCallback((sessionId: string) => {
    if (!streamBuffers.close(sessionId)) return;
    sessionStoreRef.current.finalizeStreaming(sessionId);
  }, [streamBuffers]);

  // Keep the latest pending-permission snapshot available to the websocket
  // listener so back-to-back permission events can dedupe and re-arm the
  // notification sound before React finishes a rerender.
  const pendingPermissionRequestsRef = useRef(pendingPermissionRequests);

  useEffect(() => {
    pendingPermissionRequestsRef.current = pendingPermissionRequests;
  }, [pendingPermissionRequests]);

  useEffect(() => {
    const handleEvent = (msg: ServerEvent) => {
      if (!msg.kind) {
        return;
      }

      const activeViewSessionId = activeViewSessionIdRef.current;
      const sid = (typeof msg.sessionId === 'string' && msg.sessionId) || activeViewSessionId;

      // Record replay progress for every sequenced live event.
      if (sid && typeof msg.seq === 'number') {
        const known = lastSeqRef.current.get(sid) ?? 0;
        if (msg.seq > known) {
          lastSeqRef.current.set(sid, msg.seq);
        }
      }

      switch (msg.kind) {
        case 'websocket_reconnected':
          onWebSocketReconnect?.();
          return;

        case 'history_truncated': {
          // An already-sent message was replaced. Every client watching this
          // session drops the superseded turns before the replacement streams
          // in, so a second tab does not end up showing the question twice.
          if (sid && typeof msg.anchorId === 'string') {
            sessionStore.truncateAt(sid, msg.anchorId);
          }
          return;
        }

        case 'chat_subscribed': {
          // Ack for chat.subscribe: authoritative processing state plus any
          // pending tool-permission prompts for the run.
          if (!sid) return;

          if (msg.isProcessing) {
            onSessionProcessing?.(sid);
          } else {
            // Idle ack: ignore it if a newer request started after the
            // subscribe was sent — the ack describes the older state.
            onSessionIdle?.(sid, {
              ifStartedBefore: statusCheckSentAtRef.current.get(sid),
            });
            const subscribedAt = statusCheckSentAtRef.current.get(sid);
            if (subscribedAt !== undefined) {
              const bufferedText = streamBuffers.get(sid);
              const orphanedText = bufferedText && bufferedText.lastFrameAt < subscribedAt
                ? bufferedText
                : undefined;
              const bufferedThinking = thinkingBuffers.get(sid);
              const orphanedThinking = bufferedThinking && bufferedThinking.lastFrameAt < subscribedAt
                ? bufferedThinking
                : undefined;

              const initialNoticeSource = orphanedText ?? orphanedThinking;
              if (initialNoticeSource) {
                let noticeSource = initialNoticeSource;
                if (orphanedThinking) {
                  const sourceTime = Date.parse(noticeSource.timestamp);
                  const thinkingTime = Date.parse(orphanedThinking.timestamp);
                  const sourceSeq = noticeSource.seq ?? -1;
                  const thinkingSeq = orphanedThinking.seq ?? -1;
                  if (
                    thinkingTime > sourceTime
                    || (
                      thinkingTime === sourceTime
                      && (
                        thinkingSeq > sourceSeq
                        || (
                          thinkingSeq === sourceSeq
                          && orphanedThinking.lastFrameAt >= noticeSource.lastFrameAt
                        )
                      )
                    )
                  ) {
                    noticeSource = orphanedThinking;
                  }
                }

                const sourceWasPersisted = sessionStoreRef.current.hasPersistedTurnCompletion(
                  sid,
                  {
                    id: noticeSource.id,
                    sessionId: sid,
                    timestamp: noticeSource.timestamp,
                    provider: noticeSource.provider,
                    kind: noticeSource === orphanedThinking ? 'thinking' : 'stream_delta',
                    content: noticeSource.text,
                  },
                );

                if (orphanedText) {
                  streamBuffers.drop(sid);
                  sessionStoreRef.current.discardRealtimeMessage(sid, orphanedText.id);
                }
                if (orphanedThinking) {
                  thinkingBuffers.close(sid);
                }

                // A retained completed run reports a newer lastSeq. After that
                // run is evicted, refreshed history carries the completed
                // assistant row at or after the newest partial frame.
                const knownSeq = lastSeqRef.current.get(sid) ?? 0;
                const hasUnseenTerminal = typeof msg.lastSeq === 'number'
                  && msg.lastSeq > knownSeq;
                if (!hasUnseenTerminal && !sourceWasPersisted) {
                  sessionStoreRef.current.appendRealtime(sid, {
                    id: `turn_interrupted_${sid}_${noticeSource.id}`,
                    sessionId: sid,
                    timestamp: noticeSource.timestamp,
                    provider: noticeSource.provider,
                    kind: 'turn_interrupted',
                  });
                }
              }
            }
          }

          const isViewedSession = sid === activeViewSessionId;
          if (isViewedSession && Array.isArray(msg.pendingPermissions)) {
            const nextPendingPermissionRequests = msg.pendingPermissions as PendingPermissionRequest[];
            const hadActionablePermissionRequests = hasActionablePermissionRequests(pendingPermissionRequestsRef.current);
            const hasPendingActionablePermissionRequests = hasActionablePermissionRequests(nextPendingPermissionRequests);

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);

            if (hasPendingActionablePermissionRequests && !hadActionablePermissionRequests) {
              void playNotificationSound();
            }
          }
          return;
        }

        case 'protocol_error': {
          console.error('[Chat] Protocol error:', msg.code, msg.error);
          if (sid) {
            // Surface the failure in the conversation and stop the spinner —
            // the run never started (or was rejected), so no `complete` follows.
            onSessionIdle?.(sid);
            sessionStore.appendRealtime(sid, {
              id: `protocol_error_${Date.now()}`,
              sessionId: sid,
              timestamp: new Date().toISOString(),
              provider,
              kind: 'error',
              content: String(msg.error || 'Request failed'),
            } as NormalizedMessage);
          }
          return;
        }

        // Sidebar/global events — owned by useProjectsState.
        case 'session_upserted':
        case 'loading_progress':
          return;

        default:
          break;
      }

      /* -------------------------------------------------------------- */
      /*  Provider NormalizedMessage handling                            */
      /* -------------------------------------------------------------- */

      const eventSessionId = typeof msg.sessionId === 'string' && msg.sessionId
        ? msg.sessionId
        : null;
      const eventProvider = typeof msg.provider === 'string'
        ? msg.provider as LLMProvider
        : null;
      const candidateEventTimestamp = typeof msg.timestamp === 'string'
        ? msg.timestamp
        : null;
      const eventTimestamp = candidateEventTimestamp
        && Number.isFinite(Date.parse(candidateEventTimestamp))
        ? candidateEventTimestamp
        : new Date().toISOString();
      const eventSeq = typeof msg.seq === 'number' && Number.isFinite(msg.seq)
        ? msg.seq
        : null;

      // OMP sends reasoning as small chunks. Other providers already send
      // complete thinking blocks, so they stay on the ordinary append path.
      if (msg.kind === 'thinking' && eventProvider === 'omp') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text || !eventSessionId) return;
        thinkingBuffers.append(eventSessionId, text, eventProvider, eventTimestamp, eventSeq, () => {
          thinkingBlockSeqRef.current += 1;
          return `__thinking_${eventSessionId}_${thinkingBlockSeqRef.current}`;
        });
        return;
      }

      // A tool, answer, or terminal frame closes only this session's reasoning
      // block. Interleaved frames from another session cannot disturb it.
      if (eventSessionId) {
        thinkingBuffers.close(eventSessionId);
      }

      if (msg.kind === 'stream_delta') {
        const text = typeof msg.content === 'string' ? msg.content : '';
        if (!text || !eventSessionId || !eventProvider) return;
        streamBuffers.append(
          eventSessionId,
          text,
          eventProvider,
          eventTimestamp,
          eventSeq,
          () => streamingMessageId(eventSessionId),
        );
        return;
      }

      if (msg.kind === 'stream_end') {
        if (eventSessionId) endStream(eventSessionId);
        return;
      }

      // --- All other messages: route to store ---
      const shouldPersist =
        msg.kind !== 'complete'
        && msg.kind !== 'status'
        && msg.kind !== 'permission_request'
        && msg.kind !== 'permission_resolved'
        && msg.kind !== 'permission_cancelled';

      if (sid && shouldPersist) {
        sessionStore.appendRealtime(sid, msg as unknown as NormalizedMessage);
      }

      // --- UI side effects for specific kinds ---
      switch (msg.kind) {
        case 'complete': {
          // Seal only this session. Another session may still have a dirty row
          // waiting on the shared timer.
          if (eventSessionId) endStream(eventSessionId);

          // `complete` is the unified terminal event — every provider run ends
          // with exactly one, regardless of success, failure, or abort. The
          // indicator derives from the processing map, so deleting the entry
          // hides it immediately and atomically.
          onSessionIdle?.(sid);
          if (sid === activeViewSessionId) {
            pendingPermissionRequestsRef.current = [];
            setPendingPermissionRequests([]);
          }

          if (msg.aborted) {
            // Abort was requested — the complete event confirms it. No
            // further UI action is needed beyond clearing the entry above.
            break;
          }

          // Celebrate only successful runs (failed runs end with success: false).
          if (msg.success !== false) {
            showCompletionTitleIndicator();
            void playChatCompletionSound();
          }

          // The session id is stable for the whole conversation (allocated
          // before the first send), so the only follow-up is syncing the
          // viewed conversation with the now-persisted transcript.
          if (sid && sid === activeViewSessionId) {
            void requestLatestMessages(sid, isActiveRef.current);
          }

          break;
        }

        // 'error' is an informational message row, not a terminal event —
        // providers emit it for mid-run stderr output too. Run teardown is
        // always signalled by the unified 'complete' that follows.

        case 'permission_request': {
          if (!msg.requestId) break;
          if (isActionablePermissionRequest({ toolName: msg.toolName })) {
            void playNotificationSound();
          }

          if (sid === activeViewSessionId) {
            const previousPendingPermissionRequests = pendingPermissionRequestsRef.current;
            if (!previousPendingPermissionRequests.some((request) => request.requestId === msg.requestId)) {
              const nextPendingPermissionRequests = [...previousPendingPermissionRequests, {
                requestId: msg.requestId as string,
                toolName: (msg.toolName as string) || 'UnknownTool',
                input: msg.input,
                context: msg.context,
                sessionId: sid || null,
                receivedAt: new Date(),
              }];

              pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
              setPendingPermissionRequests(nextPendingPermissionRequests);
            }
          }
          if (sid) {
            onSessionProcessing?.(sid);
          }
          break;
        }

        // `permission_resolved` arrives when any client answers the prompt: it
        // retracts a replayed `permission_request` after a mid-run refresh and
        // clears the prompt in other tabs watching the same run.
        case 'permission_resolved':
        case 'permission_cancelled': {
          if (msg.requestId && sid === activeViewSessionId) {
            const nextPendingPermissionRequests = pendingPermissionRequestsRef.current.filter(
              (request: PendingPermissionRequest) => request.requestId !== msg.requestId,
            );

            pendingPermissionRequestsRef.current = nextPendingPermissionRequests;
            setPendingPermissionRequests(nextPendingPermissionRequests);
          }
          break;
        }

        case 'status': {
          if (msg.text === 'token_budget' && msg.tokenBudget) {
            // The counter shows the viewed session's context; budgets from
            // other concurrently running sessions must not overwrite it.
            if (sid === activeViewSessionId) {
              setTokenBudget(msg.tokenBudget as Record<string, unknown>);
            }
          } else if (typeof msg.text === 'string' && msg.text && sid) {
            const value = typeof msg.status === 'string' ? msg.status : undefined;
            const configId = typeof msg.configId === 'string' ? msg.configId : undefined;
            const configLabel = configId === 'thinking'
              ? 'Thinking'
              : configId === 'mode'
                ? 'Mode'
                : 'Model';
            const statusText = msg.text === 'plan'
              ? 'Planning'
              : msg.text === 'config_option_update'
                ? (value ? `${configLabel}: ${value}` : `${configLabel} updated`)
                : msg.text === 'current_mode_update'
                  ? (value ? `Mode: ${value}` : 'Mode changed')
                  : msg.text;
            onSessionProcessing?.(sid, {
              statusText,
              canInterrupt: msg.canInterrupt !== false,
            });
          }
          break;
        }

        // text, tool_use, tool_result, thinking, task_notification
        // → already routed to store above, no UI side effects needed
        default:
          break;
      }
    };

    const unsubscribe = subscribe(handleEvent);
    return () => {
      unsubscribe();
      streamBuffers.stopTimer();
      thinkingBuffers.stopTimer();
    };
  }, [
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect,
    requestLatestMessages,
    sessionStore,
    thinkingBuffers,
    streamBuffers,
    endStream,
  ]);
}
