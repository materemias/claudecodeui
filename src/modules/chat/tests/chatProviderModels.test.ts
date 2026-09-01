import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences, writeUserPreference } from '@/shared/userSettings';
import {
  OMP_CONFIGURED_MODEL_LABEL,
  OMP_CONFIGURED_MODEL_SENTINEL,
} from '@/shared/constants';
import type {
  ProviderSessionSelectionSnapshot,
  SessionUpsertedEvent,
} from '@/shared/types';

/**
 * The four per-provider default models used to be four useState slots with four
 * copy-pasted reconciliation effects and a four-branch setter. They are now one
 * Record with one loop. These tests pin the behaviour that has to survive that:
 * each provider keeps its own model, under its own storage key, and choosing a
 * model persists it.
 */


// ES2020 test target has no Promise.withResolvers.
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const okJson = (data: unknown) => Promise.resolve({
  ok: true,
  json: async () => data,
});

const providerApi = vi.hoisted(() => ({
  sessionActiveModel: vi.fn(),
  setSessionActiveModel: vi.fn(),
  setSessionActiveEffort: vi.fn(),
}));

const sessionUpsert = (
  sessionId: string,
  selection: ProviderSessionSelectionSnapshot,
): SessionUpsertedEvent => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId: `native-${sessionId}`,
  provider: 'omp',
  session: {
    id: sessionId,
    selection,
  },
  project: null,
});

vi.mock('@/shared/api', () => ({
  api: {
    // The preference store PATCHes through api.user; it is stubbed rather than
    // exercised here, which keeps these tests about the model record.
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: providerApi.sessionActiveModel,
      setSessionActiveModel: providerApi.setSessionActiveModel,
      setSessionActiveEffort: providerApi.setSessionActiveEffort,
      createModel: () => okJson({ success: true, data: null }),
      updateModel: () => okJson({ success: true, data: null }),
      removeModel: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (
  selectedSession: { id: string; __provider: 'omp' } | null = null,
) => {
  const { useChatProviderState } = await import(
    '@/modules/chat/hooks/useChatProviderState'
  );
  return renderHook(
    ({ session }) => useChatProviderState({ selectedSession: session, selectedProject: null }),
    { initialProps: { session: selectedSession } },
  );
};

beforeEach(() => {
  localStorage.clear();
  // The preference store is a module-level singleton, so its in-memory copy
  // outlives localStorage.clear() and would leak one test's writes into the next.
  resetUserPreferences();
  providerApi.sessionActiveModel.mockReset();
  providerApi.setSessionActiveModel.mockReset();
  providerApi.setSessionActiveEffort.mockReset();
  providerApi.sessionActiveModel.mockImplementation(() => okJson({ success: true, data: null }));
  providerApi.setSessionActiveModel.mockImplementation(() => okJson({ success: true, data: null }));
  providerApi.setSessionActiveEffort.mockImplementation(() => okJson({ success: true, data: null }));
});

afterEach(() => {
  vi.resetModules();
});

test('each provider gets its own model from its own storage key', async () => {
  localStorage.setItem('claude-model', 'claude-stored');
  localStorage.setItem('cursor-model', 'cursor-stored');
  localStorage.setItem('codex-model', 'codex-stored');
  localStorage.setItem('opencode-model', 'opencode-stored');
  localStorage.setItem('omp-model', 'omp-stored');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.providerModels.claude, 'claude-stored');
  });
  assert.equal(result.current.providerModels.cursor, 'cursor-stored');
  assert.equal(result.current.providerModels.codex, 'codex-stored');
  assert.equal(result.current.providerModels.opencode, 'opencode-stored');
  assert.equal(result.current.providerModels.omp, 'omp-stored');
});

test('a provider with no stored model falls back to its own default, not another provider’s', async () => {
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  const models = result.current.providerModels;
  assert.equal(
    new Set(Object.values(models)).size,
    Object.keys(models).length,
    'each provider must have a distinct default model',
  );
});

test('OMP shows a friendly configured-default label when its catalog is unavailable', async () => {
  writeUserPreference('selectedProvider', 'omp');
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'omp');
  });
  assert.equal(result.current.currentProviderModel, OMP_CONFIGURED_MODEL_SENTINEL);
  assert.deepEqual(result.current.currentProviderModelOptions, [{
    value: OMP_CONFIGURED_MODEL_SENTINEL,
    label: OMP_CONFIGURED_MODEL_LABEL,
  }]);
});

test('OMP preserves a stored effort until its dynamic model catalog loads', async () => {
  writeUserPreference('selectedProvider', 'omp');
  localStorage.setItem('omp-effort', 'high');
  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'omp');
  });
  assert.equal(result.current.currentProviderEffort, 'high');
  assert.equal(localStorage.getItem('omp-effort'), 'high');
});

test('choosing a model persists it under that provider’s key only', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.codex);
  });
  const claudeBefore = result.current.providerModels.claude;

  act(() => {
    result.current.setStoredProviderModel('codex', 'codex-chosen');
  });

  assert.equal(result.current.providerModels.codex, 'codex-chosen');
  assert.equal(localStorage.getItem('codex-model'), 'codex-chosen');
  assert.equal(
    result.current.providerModels.claude,
    claudeBefore,
    'setting one provider must not disturb another',
  );
  assert.equal(localStorage.getItem('claude-model'), null);
});

test('setting the same model twice keeps the record identity stable', async () => {
  const { result } = await renderProviderState();
  await waitFor(() => {
    assert.ok(result.current.providerModels.claude);
  });

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });
  const afterFirst = result.current.providerModels;

  act(() => {
    result.current.setStoredProviderModel('claude', 'pinned');
  });

  assert.equal(
    result.current.providerModels,
    afterFirst,
    'a no-op write must not allocate a new record and wake consumers',
  );
});

test('the active provider’s model is what currentProviderModel reports', async () => {
  // The provider selection is a stored preference; the per-provider model is
  // still a plain localStorage key.
  writeUserPreference('selectedProvider', 'cursor');
  localStorage.setItem('cursor-model', 'cursor-active');

  const { result } = await renderProviderState();

  await waitFor(() => {
    assert.equal(result.current.provider, 'cursor');
  });
  assert.equal(result.current.currentProviderModel, 'cursor-active');
});

test('a matching live upsert seeds selection, defeats an older GET, and cannot leak across sessions', async () => {
  writeUserPreference('selectedProvider', 'omp');
  const firstGet = deferred<Awaited<ReturnType<typeof okJson>>>();
  providerApi.sessionActiveModel.mockImplementation((_provider, sessionId) => (
    sessionId === 'session-a'
      ? firstGet.promise
      : okJson({
          success: true,
          data: {
            source: 'session',
            model: 'model-b',
            effort: 'high',
            liveModel: 'live-b',
            liveEffort: 'max',
            modelDirty: false,
            effortDirty: false,
          },
        })
  ));

  const hook = await renderProviderState({ id: 'session-a', __provider: 'omp' });
  act(() => {
    hook.result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-a',
      effort: 'low',
      liveModel: 'live-a',
      liveEffort: 'high',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(hook.result.current.currentProviderModel, 'live-a');
  assert.equal(hook.result.current.currentProviderEffort, 'high');

  firstGet.resolve(await okJson({
    success: true,
    data: {
      source: 'session',
      model: 'stale-model',
      effort: 'low',
      liveModel: 'stale-live',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    },
  }));
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(hook.result.current.currentProviderModel, 'live-a');

  hook.rerender({ session: { id: 'session-b', __provider: 'omp' } });
  act(() => {
    hook.result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'wrong-session',
      effort: 'low',
      liveModel: 'wrong-session-live',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  await waitFor(() => {
    assert.equal(hook.result.current.currentProviderModel, 'live-b');
  });
  assert.equal(hook.result.current.currentProviderEffort, 'max');
});

test('sticky choices ignore old reports and stale POST responses until matching acknowledgement', async () => {
  writeUserPreference('selectedProvider', 'omp');
  providerApi.sessionActiveModel.mockImplementation(() => okJson({
    success: true,
    data: {
      source: 'session',
      model: 'model-a',
      effort: 'low',
      liveModel: 'model-a',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    },
  }));
  const modelResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  providerApi.setSessionActiveModel.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => modelResponse.promise,
  }));

  const { result } = await renderProviderState({ id: 'session-a', __provider: 'omp' });
  await waitFor(() => {
    assert.equal(result.current.currentProviderModel, 'model-a');
  });

  let selectModel: Promise<unknown>;
  act(() => {
    selectModel = result.current.selectProviderModel('omp', 'model-c', 'session-a');
  });
  assert.equal(result.current.currentProviderModel, 'model-c');

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-a',
      effort: 'low',
      liveModel: 'model-a',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(result.current.currentProviderModel, 'model-c', 'older provider report cannot replace the pick');

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'low',
      liveModel: 'model-c',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  modelResponse.resolve({
    success: true,
    data: {
      model: 'model-c',
      effort: 'low',
      liveModel: null,
      liveEffort: 'low',
      modelDirty: true,
      effortDirty: false,
    },
  });
  await act(async () => {
    await selectModel;
  });

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'low',
      liveModel: 'model-d',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(result.current.currentProviderModel, 'model-d', 'stale POST cannot re-dirty an acknowledged pick');

  const effortResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  providerApi.setSessionActiveEffort.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => effortResponse.promise,
  }));
  let selectEffort: Promise<unknown>;
  act(() => {
    selectEffort = result.current.selectProviderEffort('omp', 'max', 'session-a');
  });
  assert.equal(result.current.currentProviderEffort, 'max');

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'low',
      liveModel: 'model-d',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(result.current.currentProviderEffort, 'max', 'older effort report cannot replace the pick');

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'max',
      liveModel: 'model-d',
      liveEffort: 'max',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  effortResponse.resolve({
    success: true,
    data: {
      model: 'model-c',
      effort: 'max',
      liveModel: 'model-d',
      liveEffort: null,
      modelDirty: false,
      effortDirty: true,
    },
  });
  await act(async () => {
    await selectEffort;
  });

  act(() => {
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'max',
      liveModel: 'model-d',
      liveEffort: 'high',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(result.current.currentProviderEffort, 'high', 'stale POST cannot re-dirty acknowledged effort');

  const sentinelResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  providerApi.setSessionActiveModel.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => sentinelResponse.promise,
  }));
  let selectSentinel: Promise<unknown>;
  act(() => {
    selectSentinel = result.current.selectProviderModel(
      'omp',
      OMP_CONFIGURED_MODEL_SENTINEL,
      'session-a',
    );
    result.current.applySessionUpsertedSelection(sessionUpsert('session-a', {
      model: 'model-c',
      effort: 'max',
      liveModel: 'model-d',
      liveEffort: 'high',
      modelDirty: false,
      effortDirty: false,
    }));
  });
  assert.equal(
    result.current.currentProviderModel,
    OMP_CONFIGURED_MODEL_SENTINEL,
    'an older upsert cannot replace a pending configured-model sentinel',
  );
  sentinelResponse.resolve({
    success: true,
    data: {
      model: OMP_CONFIGURED_MODEL_SENTINEL,
      effort: 'max',
      liveModel: null,
      liveEffort: 'high',
      modelDirty: false,
      effortDirty: false,
    },
  });
  await act(async () => {
    await selectSentinel;
  });
  assert.equal(result.current.currentProviderModel, OMP_CONFIGURED_MODEL_SENTINEL);
});

test('a failed model pick cannot roll back a concurrent effort pick', async () => {
  writeUserPreference('selectedProvider', 'omp');
  providerApi.sessionActiveModel.mockImplementation(() => okJson({
    success: true,
    data: {
      model: 'model-a',
      effort: 'low',
      liveModel: 'model-a',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
      source: 'session',
    },
  }));

  const modelResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  const effortResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  providerApi.setSessionActiveModel.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => modelResponse.promise,
  }));
  providerApi.setSessionActiveEffort.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => effortResponse.promise,
  }));

  const { result } = await renderProviderState({ id: 'session-a', __provider: 'omp' });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'model-a'));

  let selectModel: Promise<unknown>;
  let selectEffort: Promise<unknown>;
  act(() => {
    selectModel = result.current.selectProviderModel('omp', 'model-b', 'session-a');
    selectEffort = result.current.selectProviderEffort('omp', 'high', 'session-a');
  });
  modelResponse.resolve({
    success: false,
    data: {
      model: 'model-a',
      effort: 'low',
      liveModel: 'model-a',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
    },
  });
  effortResponse.resolve({
    success: true,
    data: {
      model: 'model-a',
      effort: 'high',
      liveModel: 'model-a',
      liveEffort: null,
      modelDirty: false,
      effortDirty: true,
    },
  });
  let outcomes: PromiseSettledResult<unknown>[] = [];
  await act(async () => {
    outcomes = await Promise.allSettled([selectModel, selectEffort]);
  });

  assert.equal(outcomes[0]?.status, 'rejected');
  assert.equal(outcomes[1]?.status, 'fulfilled');
  assert.equal(result.current.currentProviderModel, 'model-a');
  assert.equal(result.current.currentProviderEffort, 'high');
});

test('a reconnect GET cannot replace a newer model pick with its older snapshot', async () => {
  writeUserPreference('selectedProvider', 'omp');
  const reconnectResponse = deferred<Awaited<ReturnType<typeof okJson>>>();
  providerApi.sessionActiveModel
    .mockImplementationOnce(() => okJson({
      success: true,
      data: {
        model: 'model-a',
        effort: 'low',
        liveModel: 'model-a',
        liveEffort: 'low',
        modelDirty: false,
        effortDirty: false,
        source: 'session',
      },
    }))
    .mockImplementationOnce(() => reconnectResponse.promise);

  const mutationResponse = deferred<{
    success: boolean;
    data: ProviderSessionSelectionSnapshot;
  }>();
  providerApi.setSessionActiveModel.mockImplementation(() => Promise.resolve({
    ok: true,
    json: () => mutationResponse.promise,
  }));

  const { result } = await renderProviderState({ id: 'session-a', __provider: 'omp' });
  await waitFor(() => assert.equal(result.current.currentProviderModel, 'model-a'));

  let selectModel: Promise<unknown>;
  act(() => {
    selectModel = result.current.selectProviderModel('omp', 'model-b', 'session-a');
    result.current.refreshSessionSelection();
  });
  await waitFor(() => assert.equal(providerApi.sessionActiveModel.mock.calls.length, 2));

  mutationResponse.resolve({
    success: true,
    data: {
      model: 'model-b',
      effort: 'low',
      liveModel: null,
      liveEffort: 'low',
      modelDirty: true,
      effortDirty: false,
    },
  });
  await act(async () => {
    await selectModel;
  });

  reconnectResponse.resolve(await okJson({
    success: true,
    data: {
      model: 'model-a',
      effort: 'low',
      liveModel: 'model-a',
      liveEffort: 'low',
      modelDirty: false,
      effortDirty: false,
      source: 'session',
    },
  }));
  await act(async () => {
    await reconnectResponse.promise;
  });

  assert.equal(result.current.currentProviderModel, 'model-b');
});
