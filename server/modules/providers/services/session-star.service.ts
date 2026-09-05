import { sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

type ToggleSessionStarResult = {
  sessionId: string;
  isStarred: boolean;
};

/**
 * Flips `sessions.isStarred` for one session and returns the new state.
 *
 * The id may be either the app-facing session id or the provider-native one,
 * because deep links and provider-created rows are addressed by the latter.
 * The returned `sessionId` is always the app-facing id the row is keyed by, so
 * the client can reconcile its starred set even when it asked with a provider id.
 *
 * When `desiredState` is supplied, the write is idempotent. Omitting it keeps
 * the original toggle behavior for callers that predate desired-state writes.
 */
export function toggleSessionStar(
  sessionId: string,
  desiredState?: boolean,
): ToggleSessionStarResult {
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

  const nextStarredState = typeof desiredState === 'boolean' ? desiredState : !session.isStarred;
  sessionsDb.updateSessionIsStarred(session.session_id, nextStarredState);

  return {
    sessionId: session.session_id,
    isStarred: nextStarredState,
  };
}
