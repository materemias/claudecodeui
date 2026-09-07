import { sessionsDb, type SessionRow } from '@/modules/database/index.js';
import { readOmpSessionPins, setOmpSessionPinned } from '@/modules/providers/list/omp/omp-session-pins.js';
import { AppError } from '@/shared/utils.js';

type ToggleSessionStarResult = {
  sessionId: string;
  isStarred: boolean;
};

/**
 * Sessions listing and conversation search share this provider-aware selection.
 * OMP pins come from native storage; every other provider keeps SQLite stars.
 */
export async function getStarredSessionRows(): Promise<SessionRow[]> {
  return sessionsDb.getStarredSessions(await readOmpSessionPins());
}

/**
 * Provider routes use this writer to update a session's canonical star state.
 *
 * The id may be either the app-facing session id or the provider-native one,
 * because deep links and provider-created rows are addressed by the latter.
 * The returned `sessionId` is always the app-facing id the row is keyed by, so
 * the client can reconcile its starred set even when it asked with a provider id.
 *
 * OMP writes use the native pin file, never its stale SQLite star flag.
 * A supplied `desiredState` is idempotent; omitting it toggles the current state.
 */
export async function toggleSessionStar(
  sessionId: string,
  desiredState?: boolean,
): Promise<ToggleSessionStarResult> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new AppError('sessionId is required', {
      code: 'SESSION_ID_REQUIRED',
      statusCode: 400,
    });
  }

  const session =
    sessionsDb.getSessionById(normalizedSessionId)
    ?? sessionsDb.getSessionByProviderSessionId(normalizedSessionId);

  if (!session) {
    throw new AppError(`Session "${normalizedSessionId}" was not found.`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  if (session.provider === 'omp') {
    // App IDs are provisional until OMP announces its native UUID. Writing one
    // as a pin would silently lose the star when that mapping arrives.
    if (!session.provider_session_id) {
      throw new AppError('Start this OMP session before starring it.', {
        code: 'OMP_SESSION_NOT_STARTED',
        statusCode: 409,
      });
    }
    return {
      sessionId: session.session_id,
      isStarred: await setOmpSessionPinned(session.provider_session_id, desiredState),
    };
  }

  const nextStarredState = typeof desiredState === 'boolean' ? desiredState : !session.isStarred;
  sessionsDb.updateSessionIsStarred(session.session_id, nextStarredState);

  return {
    sessionId: session.session_id,
    isStarred: nextStarredState,
  };
}
