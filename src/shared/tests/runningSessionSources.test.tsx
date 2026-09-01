import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
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
];

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: { sessions: runningSessions } }),
    }),
  },
}));

test('keeps terminal source separate and lets processing win duplicate ids', async () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionProtectionProvider>{children}</SessionProtectionProvider>
  );
  const { result } = renderHook(
    () => ({
      processing: useProcessingSessions(),
      terminal: useTerminalRunningSessions(),
      actions: useSessionProtectionActions(),
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
  assert.equal(result.current.actions.isSessionProcessing('terminal-session'), false);
  assert.equal(result.current.actions.isSessionProcessing('shared-session'), true);
});
