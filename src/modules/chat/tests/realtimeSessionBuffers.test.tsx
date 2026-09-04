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

  it('marks each lost Claude or OMP turn once at its transcript boundary', () => {
    const { result, dispatch, statusCheckSentAtRef } = renderBuffers();

    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));
    dispatch(event('stream_delta', 'A', 'claude', 'orphan', {
      seq: 1,
      timestamp: '2026-09-01T10:00:00.000Z',
    }));
    dispatch(event('thinking', 'B', 'omp', 'reasoning only', {
      seq: 1,
      timestamp: '2026-09-01T10:00:00.000Z',
    }));
    dispatch(event('stream_delta', 'C', 'omp', 'text', {
      seq: 1,
      timestamp: '2026-09-01T10:00:00.000Z',
    }));
    dispatch(event('thinking', 'C', 'omp', 'reasoning too', {
      seq: 2,
      timestamp: '2026-09-01T10:00:00.000Z',
    }));

    for (const sessionId of ['A', 'B', 'C']) {
      statusCheckSentAtRef.current.set(sessionId, Date.now() + 1);
      dispatch({
        kind: 'chat_subscribed',
        sessionId,
        isProcessing: false,
        lastSeq: 0,
      } as unknown as ServerEvent);
    }

    act(() => vi.advanceTimersByTime(100));

    assert.deepEqual(
      result.current.getMessages('A').map(message => [message.kind, message.provider]),
      [['turn_interrupted', 'claude']],
    );
    for (const sessionId of ['B', 'C']) {
      const messages = result.current.getMessages(sessionId);
      assert.equal(messages.filter(message => message.kind === 'turn_interrupted').length, 1);
      assert.equal(messages.find(message => message.kind === 'turn_interrupted')?.provider, 'omp');
      assert.equal(messages.some(message => message.kind === 'thinking'), true);
    }

    // A replayed idle acknowledgement has no buffer left to retire.
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'A',
      isProcessing: false,
      lastSeq: 0,
    } as unknown as ServerEvent);
    dispatch(event('text', 'A', 'claude', 'send again', {
      role: 'user',
      timestamp: '2026-09-01T10:00:01.000Z',
    }));

    assert.deepEqual(
      result.current.getMessages('A').map(message => message.kind),
      ['turn_interrupted', 'text'],
    );
  });

  it('does not use an earlier same-prefix assistant segment as completion evidence', async () => {
    const { result, dispatch, statusCheckSentAtRef } = renderBuffers();
    vi.setSystemTime(new Date('2026-09-01T10:01:00.000Z'));

    dispatch(event('stream_delta', 'segmented', 'claude', 'same', {
      seq: 4,
      timestamp: '2026-09-01T10:01:00.000Z',
    }));
    const history = [
      {
        id: 'segmented-user',
        sessionId: 'segmented',
        provider: 'claude',
        kind: 'text',
        role: 'user',
        content: 'question',
        timestamp: '2026-09-01T09:59:00.000Z',
      },
      {
        id: 'earlier-answer',
        sessionId: 'segmented',
        provider: 'claude',
        kind: 'text',
        role: 'assistant',
        content: 'same prefix, earlier segment',
        timestamp: '2026-09-01T10:00:00.000Z',
      },
      {
        id: 'tool-boundary',
        sessionId: 'segmented',
        provider: 'claude',
        kind: 'tool_use',
        toolId: 'call-1',
        toolName: 'Read',
        timestamp: '2026-09-01T10:00:30.000Z',
      },
    ] as NormalizedMessage[];
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { messages: history, total: history.length, hasMore: false },
      }),
    });
    await act(async () => {
      await result.current.fetchFromServer('segmented');
    });

    statusCheckSentAtRef.current.set('segmented', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'segmented',
      isProcessing: false,
      lastSeq: 0,
    } as unknown as ServerEvent);

    assert.equal(result.current.getMessages('segmented').at(-1)?.kind, 'turn_interrupted');
  });

  it('does not mark completed, failed, resumed, or tool-boundary turns', async () => {
    const { result, dispatch, statusCheckSentAtRef } = renderBuffers();

    vi.setSystemTime(new Date('2026-09-01T10:00:00.000Z'));

    // The retained run has a newer terminal frame. Completed and failed runs
    // share this terminal contract, so neither is an interruption.
    dispatch(event('stream_delta', 'completed', 'claude', 'finished', { seq: 1 }));
    statusCheckSentAtRef.current.set('completed', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'completed',
      isProcessing: false,
      lastSeq: 2,
    } as unknown as ServerEvent);

    // Once the completed run is evicted, the refreshed transcript is the
    // completion evidence. The streamed partial may be only a prefix.
    dispatch(event('stream_delta', 'persisted', 'omp', 'fin', {
      seq: 1,
      timestamp: '2026-09-01T10:00:00.000Z',
    }));
    vi.setSystemTime(new Date('2026-09-01T10:05:00.000Z'));
    const persistedHistory = [
      {
        id: 'persisted-user',
        sessionId: 'persisted',
        provider: 'omp',
        kind: 'text',
        role: 'user',
        content: 'question',
        timestamp: '2026-09-01T09:59:58.000Z',
      },
      {
        id: 'persisted-answer-1',
        sessionId: 'persisted',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'fin',
        timestamp: '2026-09-01T10:00:00.050Z',
      },
      {
        id: 'persisted-answer-2',
        sessionId: 'persisted',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'ished',
        timestamp: '2026-09-01T10:00:00.050Z',
      },
      {
        id: 'later-user',
        sessionId: 'persisted',
        provider: 'omp',
        kind: 'text',
        role: 'user',
        content: 'another tab continued',
        timestamp: '2026-09-01T10:01:00.000Z',
      },
      {
        id: 'later-answer',
        sessionId: 'persisted',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'unrelated later answer',
        timestamp: '2026-09-01T10:01:01.000Z',
      },
    ] as NormalizedMessage[];
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          messages: persistedHistory,
          total: persistedHistory.length,
          hasMore: false,
        },
      }),
    });
    await act(async () => {
      await result.current.fetchFromServer('persisted');
    });
    statusCheckSentAtRef.current.set('persisted', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'persisted',
      isProcessing: false,
      lastSeq: 0,
    } as unknown as ServerEvent);

    // A reasoning-only orphan is also complete when refreshed history has the
    // assistant answer after that reasoning frame.
    dispatch(event('thinking', 'persisted-reasoning', 'omp', 'worked it out', {
      seq: 1,
      timestamp: '2026-09-01T10:05:00.000Z',
    }));
    const reasoningHistory = [
      {
        id: 'reasoning-user',
        sessionId: 'persisted-reasoning',
        provider: 'omp',
        kind: 'text',
        role: 'user',
        content: 'question',
        timestamp: '2026-09-01T10:04:00.000Z',
      },
      {
        id: 'reasoning-answer',
        sessionId: 'persisted-reasoning',
        provider: 'omp',
        kind: 'text',
        role: 'assistant',
        content: 'answer',
        timestamp: '2026-09-01T10:05:00.050Z',
      },
    ] as NormalizedMessage[];
    sessionMessages.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          messages: reasoningHistory,
          total: reasoningHistory.length,
          hasMore: false,
        },
      }),
    });
    await act(async () => {
      await result.current.fetchFromServer('persisted-reasoning');
    });
    statusCheckSentAtRef.current.set('persisted-reasoning', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'persisted-reasoning',
      isProcessing: false,
      lastSeq: 0,
    } as unknown as ServerEvent);

    // A processing acknowledgement is followed by replay, then normal sealing.
    dispatch(event('stream_delta', 'resumed', 'omp', 'before ', { seq: 1 }));
    statusCheckSentAtRef.current.set('resumed', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'resumed',
      isProcessing: true,
      lastSeq: 2,
    } as unknown as ServerEvent);
    dispatch(event('stream_delta', 'resumed', 'omp', 'after', { seq: 2 }));
    dispatch(event('complete', 'resumed', 'omp', undefined, { seq: 3, success: true }));

    // A stream boundary retires the buffer before the tool row arrives.
    dispatch(event('stream_delta', 'tool', 'claude', 'Using a tool.', { seq: 1 }));
    dispatch(event('stream_end', 'tool', 'claude', undefined, { seq: 2 }));
    dispatch(event('tool_use', 'tool', 'claude', undefined, {
      seq: 3,
      toolId: 'call-1',
      toolName: 'Read',
    }));
    statusCheckSentAtRef.current.set('tool', Date.now() + 1);
    dispatch({
      kind: 'chat_subscribed',
      sessionId: 'tool',
      isProcessing: false,
      lastSeq: 4,
    } as unknown as ServerEvent);

    assert.equal(
      [
        ...result.current.getMessages('completed'),
        ...result.current.getMessages('persisted'),
        ...result.current.getMessages('persisted-reasoning'),
        ...result.current.getMessages('resumed'),
        ...result.current.getMessages('tool'),
      ]
        .some(message => message.kind === 'turn_interrupted'),
      false,
    );
    assert.equal(result.current.getMessages('resumed')[0]?.content, 'before after');
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
      result.current.updateThinking(
        'A',
        '__thinking_A_1',
        'First second',
        'omp',
        '2026-09-01T09:00:02.000Z',
      );
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
