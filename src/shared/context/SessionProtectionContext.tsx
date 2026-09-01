import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type {
  IsSessionProcessing,
  LLMProvider,
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivitySnapshot,
  RunningSession,
  SessionActivityMap,
  SyncProcessingSessions,
  TerminalRunningSession,
  TerminalRunningSessionMap,
} from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionsApiPayload = {
  data?: {
    sessions?: unknown[];
  };
};

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const TerminalRunningSessionsContext = createContext<TerminalRunningSessionMap | null>(null);

/**
 * The set of session ids currently producing a response, with a stable identity
 * while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useBusySessionIds(processingSessions: SessionActivityMap): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions.keys()].sort().join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseProvider = (value: unknown): LLMProvider | null => {
  if (
    value === 'claude'
    || value === 'cursor'
    || value === 'codex'
    || value === 'opencode'
    || value === 'omp'
  ) {
    return value;
  }
  return null;
};

const parseRunningSession = (session: unknown): RunningSession | null => {
  if (typeof session !== 'object' || session === null || Array.isArray(session)) {
    return null;
  }

  const sessionId = 'sessionId' in session ? session.sessionId : null;
  const provider = parseProvider('provider' in session ? session.provider : null);
  const lastSeq = 'lastSeq' in session ? session.lastSeq : null;
  if (
    typeof sessionId !== 'string'
    || !sessionId
    || !provider
    || typeof lastSeq !== 'number'
    || !Number.isInteger(lastSeq)
  ) {
    return null;
  }

  const source = 'source' in session ? session.source : null;
  if (source === 'terminal') {
    return lastSeq === 0
      ? { sessionId, provider, source, lastSeq: 0 }
      : null;
  }

  const startedAt = parseStartedAt('startedAt' in session ? session.startedAt : null);
  if (source !== 'processing' || startedAt === undefined || lastSeq < 0) {
    return null;
  }

  return {
    sessionId,
    provider,
    source,
    startedAt,
    lastSeq,
  };
};

const terminalSessionMapsMatch = (
  left: TerminalRunningSessionMap,
  right: TerminalRunningSessionMap,
): boolean => {
  if (left.size !== right.size) {
    return false;
  }

  for (const [sessionId, session] of left) {
    if (right.get(sessionId)?.provider !== session.provider) {
      return false;
    }
  }
  return true;
};

/** Mounted by the project-workspace route; owns the processing state and status-only terminal membership returned by the running-session poll. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    syncProcessingSessions,
    isSessionProcessing,
  } = useSessionProtection();
  // Keeps external terminal membership from the running-session poll without
  // marking those status-only sessions as processing or interruptible.
  const [terminalRunningSessions, setTerminalRunningSessions] = useState<Map<string, TerminalRunningSession>>(
    new Map(),
  );

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const rawSessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      const runningSessions = new Map<string, RunningSession>();

      for (const rawSession of rawSessions) {
        const session = parseRunningSession(rawSession);
        if (!session) {
          continue;
        }

        const existing = runningSessions.get(session.sessionId);
        if (!existing || session.source === 'processing') {
          runningSessions.set(session.sessionId, session);
        }
      }

      const processingSnapshots: SessionActivitySnapshot[] = [];
      const terminalSessions = new Map<string, TerminalRunningSession>();
      for (const session of runningSessions.values()) {
        if (session.source === 'terminal') {
          terminalSessions.set(session.sessionId, session);
        } else {
          processingSnapshots.push({
            sessionId: session.sessionId,
            startedAt: session.startedAt,
          });
        }
      }

      syncProcessingSessions(processingSnapshots);
      setTerminalRunningSessions((previous) => (
        terminalSessionMapsMatch(previous, terminalSessions) ? previous : terminalSessions
      ));
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    void refreshRunningSessions();
  }, [refreshRunningSessions]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshRunningSessions();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      syncProcessingSessions,
      isSessionProcessing,
    }),
    [
      isSessionProcessing,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useBusySessionIds(processingSessions);

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <TerminalRunningSessionsContext.Provider value={terminalRunningSessions}>
        <BusySessionIdsContext.Provider value={busySessionIds}>
          <SessionProtectionStateContext.Provider value={processingSessions}>
            {children}
          </SessionProtectionStateContext.Provider>
        </BusySessionIdsContext.Provider>
      </TerminalRunningSessionsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of sessions processing through CloudCLI. Prefer this
 * over useProcessingSessions wherever activity details are not rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/** Used by the project-workspace shell to render external terminal sessions without treating them as interruptible chat runs. */
export function useTerminalRunningSessions(): TerminalRunningSessionMap {
  const sessions = useContext(TerminalRunningSessionsContext);
  if (!sessions) {
    throw new Error('useTerminalRunningSessions must be used within SessionProtectionProvider');
  }
  return sessions;
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
