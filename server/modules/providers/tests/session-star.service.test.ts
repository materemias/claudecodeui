import assert from 'node:assert/strict';
import test from 'node:test';

import { sessionsDb, type SessionRow } from '@/modules/database/index.js';
import { toggleSessionStar } from '@/modules/providers/services/session-star.service.js';
import { AppError } from '@/shared/utils.js';

function buildSessionRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    session_id: 'session-1',
    provider: 'claude',
    provider_session_id: null,
    project_path: '/workspace/project-1',
    isStarred: 0,
    isArchived: 0,
    is_one_shot: 0,
    ...overrides,
  } as SessionRow;
}

test('toggleSessionStar throws when sessionId is missing', () => {
  assert.throws(
    () => toggleSessionStar('   '),
    (error: unknown) =>
      error instanceof AppError
      && error.code === 'SESSION_ID_REQUIRED'
      && error.statusCode === 400,
  );
});

test('toggleSessionStar throws when the session does not exist', () => {
  const originalGetSessionById = sessionsDb.getSessionById;
  const originalGetSessionByProviderSessionId = sessionsDb.getSessionByProviderSessionId;

  try {
    sessionsDb.getSessionById = () => null;
    sessionsDb.getSessionByProviderSessionId = () => null;

    assert.throws(
      () => toggleSessionStar('session-1'),
      (error: unknown) =>
        error instanceof AppError
        && error.code === 'SESSION_NOT_FOUND'
        && error.statusCode === 404,
    );
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    sessionsDb.getSessionByProviderSessionId = originalGetSessionByProviderSessionId;
  }
});

test('toggleSessionStar flips star state in both directions and persists it', () => {
  const originalGetSessionById = sessionsDb.getSessionById;
  const originalUpdateSessionIsStarred = sessionsDb.updateSessionIsStarred;

  let storedState = 0;
  let capturedSessionId = '';

  try {
    sessionsDb.getSessionById = () => buildSessionRow({ isStarred: storedState });
    sessionsDb.updateSessionIsStarred = (sessionId: string, isStarred: boolean) => {
      capturedSessionId = sessionId;
      storedState = isStarred ? 1 : 0;
    };

    const starred = toggleSessionStar('session-1');

    assert.deepEqual(starred, { sessionId: 'session-1', isStarred: true });
    assert.equal(capturedSessionId, 'session-1');
    assert.equal(storedState, 1);

    const unstarred = toggleSessionStar('session-1');

    assert.deepEqual(unstarred, { sessionId: 'session-1', isStarred: false });
    assert.equal(storedState, 0);
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    sessionsDb.updateSessionIsStarred = originalUpdateSessionIsStarred;
  }
});

test('toggleSessionStar accepts an explicit state without flipping it on retries', () => {
  const originalGetSessionById = sessionsDb.getSessionById;
  const originalUpdateSessionIsStarred = sessionsDb.updateSessionIsStarred;
  const writtenStates: boolean[] = [];

  try {
    sessionsDb.getSessionById = () => buildSessionRow({ isStarred: writtenStates.at(-1) ? 1 : 0 });
    sessionsDb.updateSessionIsStarred = (_sessionId: string, isStarred: boolean) => {
      writtenStates.push(isStarred);
    };

    assert.deepEqual(toggleSessionStar('session-1', true), {
      sessionId: 'session-1',
      isStarred: true,
    });
    assert.deepEqual(toggleSessionStar('session-1', true), {
      sessionId: 'session-1',
      isStarred: true,
    });
    assert.deepEqual(writtenStates, [true, true]);
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    sessionsDb.updateSessionIsStarred = originalUpdateSessionIsStarred;
  }
});

test('toggleSessionStar resolves a provider-native id onto the app session id', () => {
  const originalGetSessionById = sessionsDb.getSessionById;
  const originalGetSessionByProviderSessionId = sessionsDb.getSessionByProviderSessionId;
  const originalUpdateSessionIsStarred = sessionsDb.updateSessionIsStarred;

  let capturedSessionId = '';

  try {
    sessionsDb.getSessionById = () => null;
    sessionsDb.getSessionByProviderSessionId = () =>
      buildSessionRow({ session_id: 'app-session-1', provider_session_id: 'provider-native-1' });
    sessionsDb.updateSessionIsStarred = (sessionId: string) => {
      capturedSessionId = sessionId;
    };

    const result = toggleSessionStar('provider-native-1');

    assert.deepEqual(result, { sessionId: 'app-session-1', isStarred: true });
    assert.equal(capturedSessionId, 'app-session-1');
  } finally {
    sessionsDb.getSessionById = originalGetSessionById;
    sessionsDb.getSessionByProviderSessionId = originalGetSessionByProviderSessionId;
    sessionsDb.updateSessionIsStarred = originalUpdateSessionIsStarred;
  }
});
