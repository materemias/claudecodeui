import { createRef, forwardRef, useImperativeHandle, useMemo } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedMessage, Project, ProjectSession } from '@/shared/types';
import { useChatSessionState } from '@/modules/chat/hooks/useChatSessionState';

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionTokenUsage: () => Promise.resolve({ ok: false, json: async () => ({}) }),
    },
  },
}));

const SESSION_B_ID = 'turn-navigation-session-b';
const SESSION_ID = 'turn-navigation-session';
const project: Project = {
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
};
const session = { id: SESSION_ID } as ProjectSession;
const buildMessage = (
  id: string,
  role: 'user' | 'assistant',
  index: number,
  sessionId = SESSION_ID,
): NormalizedMessage => ({
  id,
  kind: 'text',
  role,
  provider: 'claude',
  sessionId,
  content: id,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
} as NormalizedMessage);

function buildLongTranscript(): NormalizedMessage[] {
  const messages = [buildMessage('previous', 'user', 0)];
  for (let index = 1; index < 120; index += 1) {
    messages.push(buildMessage(`assistant-${index}`, 'assistant', index));
  }
  messages.push(buildMessage('current', 'user', 120));
  return messages;
}

function createStore(messages: NormalizedMessage[]) {
  const slot = {
    fetchedAt: 1,
    status: 'idle' as const,
    total: messages.length,
    hasMore: false,
    offset: messages.length,
  };

  return {
    fetchFromServer: vi.fn(async (_sessionId: string) => slot),
    fetchMore: vi.fn(async (_sessionId: string) => ({ slot, prependedCount: 0 })),
    appendRealtime: vi.fn(),
    refreshLatestFromServer: vi.fn(async () => ({
      slot,
      applied: true,
      changed: false,
      deferred: false,
    })),
    setActiveSession: vi.fn(),
    isStale: vi.fn(() => false),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn((_sessionId: string) => messages),
    getSessionSlot: vi.fn((_sessionId: string) => slot),
  };
}

type NavigateUserTurn = (direction: 'previous' | 'next') => Promise<void>;
type HarnessHandle = {
  navigateUserTurn: NavigateUserTurn;
  scrollToBottomAndReset: () => void;
  isLoadingSessionMessages: boolean;
  visibleMessagesLength: number;
  navigatingUserTurn: 'previous' | 'next' | null;
  hasMoreMessages: boolean;
  totalMessages: number;
};
type HarnessProps = {
  messages: NormalizedMessage[];
  viewedSession?: ProjectSession;
  sessionStore?: unknown;
};
const scrolledMessageIds: string[] = [];

const Harness = forwardRef<HarnessHandle, HarnessProps>(function Harness({
  messages,
  viewedSession = session,
  sessionStore,
}, ref) {
  const defaultStore = useMemo(() => createStore(messages), [messages]);
  const store = sessionStore ?? defaultStore;
  const state = useChatSessionState({
    isActive: true,
    selectedProject: project,
    selectedSession: viewedSession,
    ws: null,
    sendMessage: vi.fn(),
    resetStreamingState: vi.fn(),
    statusCheckSentAtRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    sessionStore: store as never,
  });
  useImperativeHandle(ref, () => ({
    navigateUserTurn: state.navigateUserTurn,
    scrollToBottomAndReset: state.scrollToBottomAndReset,
    isLoadingSessionMessages: state.isLoadingSessionMessages,
    visibleMessagesLength: state.visibleMessages.length,
    navigatingUserTurn: state.navigatingUserTurn,
    hasMoreMessages: state.hasMoreMessages,
    totalMessages: state.totalMessages,
  }), [state]);

  return (
    <div ref={state.scrollContainerRef} data-testid="transcript">
      {state.visibleMessages
        .filter((message) => message.type === 'user')
        .map((message) => (
          <div
            key={String(message.timestamp)}
            data-user-turn=""
            data-message-id={message.content}
            data-message-timestamp={message.timestamp}
          />
        ))}
    </div>
  );
});

beforeEach(() => {
  scrolledMessageIds.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(performance.now()), 0)
  ));
  vi.stubGlobal('cancelAnimationFrame', (timer: number) => window.clearTimeout(timer));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'transcript') return new DOMRect(0, 0, 100, 600);
    if (this.dataset.messageId === 'previous') return new DOMRect(0, 100, 100, 100);
    if (this.dataset.messageId === 'current') return new DOMRect(0, 250, 100, 100);
    if (this.dataset.messageId === 'next') return new DOMRect(0, 500, 100, 100);
    return new DOMRect();
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement) {
      if (this.dataset.messageId) scrolledMessageIds.push(this.dataset.messageId);
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('user turn navigation', () => {
  it('uses persistent turn wrappers without requiring message content to be mounted', async () => {
    const harnessRef = createRef<HarnessHandle>();
    render(<Harness ref={harnessRef} messages={[
      buildMessage('previous', 'user', 0),
      buildMessage('current', 'user', 1),
      buildMessage('next', 'user', 2),
    ]} />);

    await waitFor(() => expect(harnessRef.current?.isLoadingSessionMessages).toBe(false));
    const navigate = harnessRef.current?.navigateUserTurn;
    if (!navigate) throw new Error('navigation callback was not rendered');
    const turns = document.querySelectorAll<HTMLElement>('[data-user-turn]');
    expect(turns).toHaveLength(3);
    expect(turns[0].getBoundingClientRect().top).toBe(100);
    expect(turns[0].isConnected).toBe(true);

    act(() => {
      void navigate('next');
    });
    await waitFor(() => expect(scrolledMessageIds).toEqual(['next', 'next']));

    act(() => {
      void navigate('previous');
    });
    await waitFor(() => {
      expect(scrolledMessageIds).toEqual(['next', 'next', 'current', 'current']);
    });

    act(() => {
      void navigate('previous');
    });
    await waitFor(() => {
      expect(scrolledMessageIds).toEqual([
        'next',
        'next',
        'current',
        'current',
        'previous',
        'previous',
      ]);
    });
  });

  it('widens the tail window to reach an older loaded user turn', async () => {
    const messages = buildLongTranscript();
    const harnessRef = createRef<HarnessHandle>();

    render(<Harness ref={harnessRef} messages={messages} />);
    await waitFor(() => expect(harnessRef.current?.isLoadingSessionMessages).toBe(false));
    expect(harnessRef.current?.visibleMessagesLength).toBe(100);
    const navigate = harnessRef.current?.navigateUserTurn;
    if (!navigate) throw new Error('navigation callback was not rendered');

    act(() => {
      void navigate('previous');
    });

    await waitFor(() => expect(harnessRef.current?.visibleMessagesLength).toBe(messages.length));
    await waitFor(() => expect(scrolledMessageIds).toEqual(['previous', 'previous']));
  });

  it('lets an explicit scroll to bottom cancel a pending turn jump', async () => {
    const messages = buildLongTranscript();
    const harnessRef = createRef<HarnessHandle>();
    render(<Harness ref={harnessRef} messages={messages} />);
    await waitFor(() => expect(harnessRef.current?.isLoadingSessionMessages).toBe(false));
    const navigate = harnessRef.current?.navigateUserTurn;
    const scrollToBottom = harnessRef.current?.scrollToBottomAndReset;
    if (!navigate || !scrollToBottom) throw new Error('scroll callbacks were not rendered');

    let navigationPromise: Promise<void> | null = null;
    act(() => {
      navigationPromise = navigate('previous');
      scrollToBottom();
    });
    if (!navigationPromise) throw new Error('navigation did not start');
    await act(async () => {
      await navigationPromise;
    });

    expect(harnessRef.current?.navigatingUserTurn).toBeNull();
    expect(scrolledMessageIds).toEqual([]);
  });

  it('discards an older-page result after switching sessions', async () => {
    const sessionAUser = buildMessage('current', 'user', 0);
    const sessionBUser = buildMessage('session-b-current', 'user', 1, SESSION_B_ID);
    const messagesBySession = new Map<string, NormalizedMessage[]>([
      [SESSION_ID, [sessionAUser]],
      [SESSION_B_ID, [sessionBUser]],
    ]);
    const slotA = {
      fetchedAt: 1,
      status: 'idle' as const,
      total: 2,
      hasMore: true,
      offset: 1,
    };
    const slotB = {
      fetchedAt: 1,
      status: 'idle' as const,
      total: 1,
      hasMore: false,
      offset: 1,
    };
    type OlderPageResult = { slot: typeof slotA; prependedCount: number };
    const olderPageGate: { resolve?: (result: OlderPageResult) => void } = {};
    const olderPage = new Promise<OlderPageResult>((resolve) => {
      olderPageGate.resolve = resolve;
    });
    const store = createStore([]);
    store.fetchFromServer.mockImplementation(async (sessionId: string) => (
      sessionId === SESSION_ID ? slotA : slotB
    ));
    store.fetchMore.mockImplementation(async () => olderPage);
    store.getMessages.mockImplementation((sessionId: string) => messagesBySession.get(sessionId) ?? []);
    store.getSessionSlot.mockImplementation((sessionId: string) => (
      sessionId === SESSION_ID ? slotA : slotB
    ));

    const sessionB = { id: SESSION_B_ID } as ProjectSession;
    const harnessRef = createRef<HarnessHandle>();
    const view = render(<Harness ref={harnessRef} messages={[]} sessionStore={store} />);
    await waitFor(() => {
      expect(harnessRef.current?.isLoadingSessionMessages).toBe(false);
      expect(harnessRef.current?.hasMoreMessages).toBe(true);
    });
    const navigate = harnessRef.current?.navigateUserTurn;
    if (!navigate) throw new Error('navigation callback was not rendered');

    let navigationPromise: Promise<void> | null = null;
    act(() => {
      navigationPromise = navigate('previous');
    });
    await waitFor(() => expect(store.fetchMore).toHaveBeenCalledTimes(1));

    view.rerender(
      <Harness ref={harnessRef} messages={[]} viewedSession={sessionB} sessionStore={store} />,
    );
    await waitFor(() => {
      expect(harnessRef.current?.isLoadingSessionMessages).toBe(false);
      expect(harnessRef.current?.totalMessages).toBe(1);
    });

    const resolvePage = olderPageGate.resolve;
    if (!resolvePage || !navigationPromise) throw new Error('older page request was not pending');
    act(() => {
      resolvePage({ slot: slotA, prependedCount: 1 });
    });
    await act(async () => {
      await navigationPromise;
    });

    expect(harnessRef.current?.totalMessages).toBe(1);
    expect(harnessRef.current?.hasMoreMessages).toBe(false);
    expect(harnessRef.current?.visibleMessagesLength).toBe(1);
  });
});
