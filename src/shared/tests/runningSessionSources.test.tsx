import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import {
  SessionProtectionProvider,
  useProcessingSessions,
  useSessionProtectionActions,
  useRecentWebSessions,
  useTerminalRunningSessions,
} from '@/shared/context/SessionProtectionContext';
import { beforeEach, test, vi } from 'vitest';

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
    sessionId: 'one-shot-terminal',
    provider: 'claude',
    source: 'terminal',
    lastSeq: 0,
    isOneShot: true,
  },
  {
    sessionId: 'invalid-one-shot-terminal',
    provider: 'claude',
    source: 'terminal',
    lastSeq: 0,
    isOneShot: 'true',
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
    isOneShot: false,
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

const runningSessionsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    runningSessions: () => runningSessionsResponse(),
  },
}));

beforeEach(() => {
  runningSessionsResponse.mockReset();
  runningSessionsResponse.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ data: { sessions: runningSessions } }),
  });
});

const renderSources = () => {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SessionProtectionProvider>{children}</SessionProtectionProvider>
  );
  return renderHook(
    () => ({
      processing: useProcessingSessions(),
      terminal: useTerminalRunningSessions(),
      actions: useSessionProtectionActions(),
      recent: useRecentWebSessions(),
    }),
    { wrapper },
  );
};

test('keeps terminal and recent sources separate while processing wins duplicate ids', async () => {
  const { result } = renderSources();

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
  assert.equal(result.current.terminal.get('one-shot-terminal')?.isOneShot, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      result.current.terminal.get('invalid-one-shot-terminal'),
      'isOneShot',
    ),
    false,
  );
  assert.deepEqual(result.current.recent.get('recent-session'), {
    sessionId: 'recent-session',
    provider: 'cursor',
    source: 'recent',
    projectId: 'project-1',
    sessionTitle: 'Recent session',
    lastActivity: '2026-08-31T10:00:00.000Z',
    completedAt: 200,
    lastSeq: 0,
    isOneShot: false,
  });
  assert.equal(result.current.recent.has('shared-session'), false);
  assert.equal(result.current.recent.has('malformed-recent'), false);
  assert.equal(result.current.actions.isSessionProcessing('recent-session'), false);
  assert.equal(result.current.actions.isSessionProcessing('terminal-session'), false);
  assert.equal(result.current.actions.isSessionProcessing('shared-session'), true);
});

test('only the newest running-source request mutates membership', async () => {
  const { result } = renderSources();
  await waitFor(() => assert.equal(result.current.terminal.has('terminal-session'), true));

  let releaseStale: (() => void) | null = null;
  const staleGate = new Promise<void>((resolve) => {
    releaseStale = resolve;
  });
  runningSessionsResponse.mockImplementationOnce(async () => {
    await staleGate;
    return {
      ok: true,
      json: async () => ({
        data: {
          sessions: [{
            sessionId: 'stale-session',
            provider: 'claude',
            source: 'terminal',
            lastSeq: 0,
          }],
        },
      }),
    };
  });
  const staleRequest = result.current.actions.refreshRunningSessions();

  runningSessionsResponse.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      data: {
        sessions: [{
          sessionId: 'newest-session',
          provider: 'omp',
          source: 'terminal',
          lastSeq: 0,
        }],
      },
    }),
  });
  await act(async () => {
    await result.current.actions.refreshRunningSessions();
  });

  await act(async () => {
    releaseStale?.();
    await staleRequest;
  });

  assert.deepEqual([...result.current.terminal.keys()], ['newest-session']);
});

test('a failed running-source request leaves every source unchanged', async () => {
  const { result } = renderSources();
  await waitFor(() => assert.equal(result.current.processing.has('shared-session'), true));

  const processingBefore = result.current.processing;
  const terminalBefore = result.current.terminal;
  const recentBefore = result.current.recent;
  runningSessionsResponse.mockResolvedValueOnce({ ok: false, status: 503 });

  await act(async () => {
    const refreshed = await result.current.actions.refreshRunningSessions();
    assert.equal(refreshed, null);
  });

  assert.equal(result.current.processing, processingBefore);
  assert.equal(result.current.terminal, terminalBefore);
  assert.equal(result.current.recent, recentBefore);
});
