import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
  useRecentWebSessions,
  useTerminalRunningSessions,
} from '@/shared/context/SessionProtectionContext';
import { test, vi } from 'vitest';

const runningSessions = [
  {
    sessionId: 'terminal-session',
    provider: 'omp',
    source: 'terminal',
    lastSeq: 0,
  },
  {
    sessionId: 'shared-session',
    provider: 'codex',
    source: 'terminal',
    lastSeq: 0,
  },
  {
    sessionId: 'shared-session',
    provider: 'codex',
    source: 'processing',
    startedAt: 100,
    lastSeq: 7,
  },
  {
    sessionId: 'malformed-terminal',
    provider: 'unknown',
    source: 'terminal',
    lastSeq: 0,
  },
  {
    sessionId: 'recent-session',
    provider: 'cursor',
    source: 'recent',
    projectId: 'project-1',
    sessionTitle: 'Recent session',
    lastActivity: '2026-08-31T10:00:00.000Z',
    completedAt: 200,
    lastSeq: 0,
  },
  {
    sessionId: 'shared-session',
    provider: 'codex',
    source: 'recent',
    projectId: 'project-1',
    sessionTitle: 'Superseded recent session',
    lastActivity: null,
    completedAt: 300,
    lastSeq: 0,
  },
  {
    sessionId: 'malformed-recent',
    provider: 'claude',
    source: 'recent',
    completedAt: 400,
    lastSeq: 0,
  },
];

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { sessions: runningSessions } }),
    }),
  },
}));

test('keeps terminal and recent sources separate while processing wins duplicate ids', async () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionProtectionProvider>{children}</SessionProtectionProvider>
  );
  const { result } = renderHook(
    () => ({
      processing: useProcessingSessions(),
      terminal: useTerminalRunningSessions(),
      actions: useSessionProtectionActions(),
      recent: useRecentWebSessions(),
    }),
    { wrapper },
  );

  await waitFor(() => assert.equal(result.current.processing.has('shared-session'), true));

  assert.equal(result.current.processing.has('terminal-session'), false);
  assert.equal(result.current.terminal.has('shared-session'), false);
  assert.deepEqual(result.current.terminal.get('terminal-session'), {
    sessionId: 'terminal-session',
    provider: 'omp',
    source: 'terminal',
    lastSeq: 0,
  });
  assert.equal(result.current.terminal.has('malformed-terminal'), false);
  assert.deepEqual(result.current.recent.get('recent-session'), {
    sessionId: 'recent-session',
    provider: 'cursor',
    source: 'recent',
    projectId: 'project-1',
    sessionTitle: 'Recent session',
    lastActivity: '2026-08-31T10:00:00.000Z',
    completedAt: 200,
    lastSeq: 0,
  });
  assert.equal(result.current.recent.has('shared-session'), false);
  assert.equal(result.current.recent.has('malformed-recent'), false);
  assert.equal(result.current.actions.isSessionProcessing('recent-session'), false);
  assert.equal(result.current.actions.isSessionProcessing('terminal-session'), false);
  assert.equal(result.current.actions.isSessionProcessing('shared-session'), true);
});
