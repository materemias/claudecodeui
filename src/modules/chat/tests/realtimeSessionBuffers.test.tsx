import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import { useSessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { LLMProvider, NormalizedMessage, ProjectSession, ServerEvent } from '@/shared/types';
const sessionMessages = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const selectedSession = (id: string) => ({ id }) as ProjectSession;

const event = (
  kind: ServerEvent['kind'],
  sessionId: string,
  provider: LLMProvider,
  content?: string,
  extra: Record<string, unknown> = {},
): ServerEvent => ({ kind, sessionId, provider, content, ...extra }) as unknown as ServerEvent;

function renderBuffers(initialSessionId = 'viewed') {
  let listener: ((message: ServerEvent) => void) | null = null;
  const subscribe = (nextListener: (message: ServerEvent) => void) => {
    listener = nextListener;
    return () => {
      if (listener === nextListener) listener = null;
    };
  };
  const statusCheckSentAtRef = { current: new Map<string, number>() };
  const lastSeqRef = { current: new Map<string, number>() };

  const view = renderHook(
    ({ sessionId }: { sessionId: string }) => {
      const store = useSessionStore();
      useChatRealtimeHandlers({
        isActive: true,
        subscribe,
        provider: 'claude',
        selectedSession: selectedSession(sessionId),
        currentSessionId: sessionId,
        setTokenBudget: () => {},
        pendingPermissionRequests: [],
        setPendingPermissionRequests: () => {},
        lastSeqRef,
        statusCheckSentAtRef,
        requestLatestMessages: async () => {},
        sessionStore: store,
      });
      return store;
    },
    { initialProps: { sessionId: initialSessionId } },
  );

  const dispatch = (message: ServerEvent) => {
    act(() => listener?.(message));
  };

  return { ...view, dispatch, lastSeqRef, statusCheckSentAtRef };
}

beforeEach(() => {
  vi.useFakeTimers();
  sessionMessages.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('session-keyed realtime buffers', () => {
  it('keeps interleaved Claude text and OMP reasoning isolated through terminal events', () => {
    const { result, dispatch } = renderBuffers();

    dispatch(event('stream_delta', 'A', 'claude', 'A1'));
    dispatch(event('stream_delta', 'B', 'omp', 'B1'));
    dispatch(event('stream_delta', 'A', 'claude', 'A2'));
    dispatch(event('thinking', 'B', 'omp', 'think '));
    dispatch(event('thinking', 'B', 'omp', 'more'));

    dispatch(event('complete', 'A', 'claude', undefined, { success: false }));
    dispatch(event('stream_delta', 'C', 'claude', 'C1'));
    dispatch(event('complete', 'C', 'claude', undefined, { aborted: true }));

    act(() => vi.advanceTimersByTime(100));

    const a = result.current.getMessages('A');
    const b = result.current.getMessages('B');
    const c = result.current.getMessages('C');

    assert.equal(a.length, 1);
    assert.equal(a[0].kind, 'text');
    assert.equal(a[0].content, 'A1A2');
    assert.equal(a[0].provider, 'claude');

    assert.deepEqual(
      b.map(message => [message.kind, message.content, message.provider]),
      [
        ['text', 'B1', 'omp'],
        ['thinking', 'think more', 'omp'],
      ],
    );

    assert.equal(c.length, 1);
    assert.equal(c[0].kind, 'text');
    assert.equal(c[0].content, 'C1');
  });

  it('seals assistant rows at tool, status, error, and terminal boundaries per session', () => {
    const { result, dispatch, lastSeqRef } = renderBuffers();

    dispatch(event('stream_delta', 'A', 'omp', 'first', { seq: 1 }));
    dispatch(event('stream_delta', 'B', 'omp', 'B1', { seq: 1 }));
    dispatch(event('permission_request', 'B', 'omp', undefined, {
      seq: 2,
      requestId: 'permission-1',
      toolName: 'Read',
    }));
    dispatch(event('tool_use', 'A', 'omp', undefined, {
      seq: 2,
      toolId: 'call-1',
      toolName: 'Read',
    }));
    dispatch(event('stream_delta', 'A', 'omp', 'second', { seq: 3 }));
    dispatch(event('tool_result', 'A', 'omp', 'result', { seq: 4, toolId: 'call-1' }));
    dispatch(event('stream_delta', 'A', 'omp', 'third', { seq: 5 }));
    dispatch(event('status', 'A', 'omp', undefined, { seq: 6, text: 'plan' }));
    dispatch(event('stream_delta', 'A', 'omp', 'fourth', { seq: 7 }));
    dispatch(event('error', 'A', 'omp', 'failed', { seq: 8 }));
    dispatch(event('stream_delta', 'A', 'omp', 'fifth', { seq: 9 }));
    dispatch(event('complete', 'A', 'omp', undefined, { seq: 10, aborted: true }));
    dispatch(event('stream_delta', 'A', 'omp', 'sixth', { seq: 11 }));
    dispatch(event('stream_delta', 'B', 'omp', 'B2', { seq: 3 }));
    dispatch(event('stream_end', 'B', 'omp', undefined, { seq: 4 }));
    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(
      result.current.getMessages('A').map(message => [message.kind, message.content]),
      [
        ['text', 'first'],
        ['tool_use', undefined],
        ['text', 'second'],
        ['tool_result', 'result'],
        ['text', 'third'],
        ['text', 'fourth'],
        ['error', 'failed'],
        ['text', 'fifth'],
        ['stream_delta', 'sixth'],
      ],
    );
    assert.deepEqual(
      result.current.getMessages('B').map(message => [message.kind, message.content]),
      [['text', 'B1B2']],
    );
    assert.equal(lastSeqRef.current.get('A'), 11);
    assert.equal(lastSeqRef.current.get('B'), 4);
  });

  it('reconciles each sealed assistant row with its persisted copy', async () => {
    const { result, dispatch } = renderBuffers();
    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));

    dispatch(event('stream_delta', 'A', 'omp', 'first'));
    dispatch(event('tool_use', 'A', 'omp', undefined, {
      id: 'tool-live',
      toolId: 'call-1',
      toolName: 'Read',
    }));
    dispatch(event('stream_delta', 'A', 'omp', 'second'));
    dispatch(event('complete', 'A', 'omp'));

    const history = [
      {
        id: 'user-1',
        sessionId: 'A',
        provider: 'omp',
        kind: 'text',
        role: 'user',
        content: 'question',
        timestamp: '2026-09-01T09:00:00.000Z',
      },
      {
        id: 'assistant-1',
        sessionId: 'A',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'first',
        timestamp: '2026-09-01T09:00:01.000Z',
      },
      {
        id: 'tool-1',
        sessionId: 'A',
        provider: 'omp',
        kind: 'tool_use',
        toolId: 'call-1',
        toolName: 'Read',
        timestamp: '2026-09-01T09:00:02.000Z',
      },
      {
        id: 'assistant-2',
        sessionId: 'A',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'second',
        timestamp: '2026-09-01T09:00:03.000Z',
      },
    ] as NormalizedMessage[];
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { messages: history, total: history.length, hasMore: false },
      }),
    });

    await act(async () => {
      await result.current.fetchFromServer('A');
    });

    assert.deepEqual(
      result.current.getMessages('A').map(message => message.id),
      history.map(message => message.id),
    );
    assert.deepEqual(result.current.getSessionSlot('A')?.realtimeMessages, []);
  });

  it('preserves dirty rows across a session switch and listener re-subscribe', () => {
    const { result, dispatch, rerender } = renderBuffers('A');

    dispatch(event('stream_delta', 'A', 'claude', 'before '));
    dispatch(event('thinking', 'B', 'omp', 'reason '));

    rerender({ sessionId: 'B' });

    dispatch(event('stream_delta', 'A', 'claude', 'after'));
    dispatch(event('thinking', 'B', 'omp', 'resume'));
    act(() => vi.advanceTimersByTime(100));

    assert.equal(result.current.getMessages('A')[0]?.content, 'before after');
    assert.equal(result.current.getMessages('B')[0]?.content, 'reason resume');
  });

  it('drops an idle orphan by session without a later timer restoring it', () => {
    const { result, dispatch, statusCheckSentAtRef } = renderBuffers();

    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    dispatch(event('stream_delta', 'A', 'claude', 'orphan'));
    dispatch(event('stream_delta', 'B', 'omp', 'live'));

    statusCheckSentAtRef.current.set('A', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'A',
      isProcessing: false,
    } as unknown as ServerEvent);

    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(result.current.getMessages('A'), []);
    assert.equal(result.current.getMessages('B')[0]?.content, 'live');

    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'A',
      isProcessing: true,
    } as unknown as ServerEvent);
    dispatch(event('stream_delta', 'A', 'claude', 'resumed'));
    act(() => vi.advanceTimersByTime(100));

    assert.equal(result.current.getMessages('A')[0]?.content, 'resumed');
  });

  it('prunes a live reasoning block when persisted parts preserve whitespace across their boundary', async () => {
    const { result } = renderBuffers();
    const history = [
      {
        id: 'user',
        sessionId: 'A',
        provider: 'omp',
        kind: 'text',
        role: 'user',
        content: 'question',
        timestamp: '2026-09-01T09:00:00.000Z',
      },
      {
        id: 'thinking-1',
        sessionId: 'A',
        provider: 'omp',
        kind: 'thinking',
        content: 'First ',
        timestamp: '2026-09-01T09:00:01.000Z',
      },
      {
        id: 'thinking-2',
        sessionId: 'A',
        provider: 'omp',
        kind: 'thinking',
        content: 'second',
        timestamp: '2026-09-01T09:00:02.000Z',
      },
    ] as NormalizedMessage[];
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { messages: history, total: history.length, hasMore: false },
      }),
    });

    act(() => {
      result.current.updateThinking('A', '__thinking_A_1', 'First second', 'omp');
    });
    await act(async () => {
      await result.current.fetchFromServer('A');
    });

    const messages = result.current.getMessages('A');
    assert.deepEqual(messages.map(message => message.id), ['user', 'thinking-1', 'thinking-2']);
  });

  it('does not render a replayed live tool beside its persisted history row', async () => {
    const { result } = renderBuffers();
    const persistedTool = {
      id: 'history-tool',
      sessionId: 'A',
      provider: 'omp',
      kind: 'tool_use',
      toolId: 'call-1',
      toolName: 'read',
      timestamp: '2026-09-01T09:00:00.000Z',
    } as NormalizedMessage;
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { messages: [persistedTool], total: 1, hasMore: false },
      }),
    });

    await act(async () => {
      await result.current.fetchFromServer('A');
    });
    act(() => {
      result.current.appendRealtime('A', {
        ...persistedTool,
        id: 'live-tool',
      });
    });

    assert.deepEqual(result.current.getMessages('A').map(message => message.id), ['history-tool']);
  });
});
