import { providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { OMP_CONFIGURED_MODEL_SENTINEL } from '@/modules/providers/list/omp/omp-models.provider.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  PendingProviderSessionSelection,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionConfigReport,
  ProviderSessionModel,
  ProviderSessionSelectionSnapshot,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionRow = {
  session_id: string;
  provider: string;
  model: string | null;
  effort: string | null;
  live_model: string | null;
  live_effort: string | null;
  model_dirty: number;
  effort_dirty: number;
};

type ProviderModelsSessionStore = {
  getSessionById(sessionId: string): ProviderModelsSessionRow | null;
  getSessionByProviderSessionId(sessionId: string): ProviderModelsSessionRow | null;
  setSessionModel(sessionId: string, model: string, pending: boolean): void;
  setSessionEffort(sessionId: string, effort: string, pending: boolean): void;
  recordSessionModelOnSend(sessionId: string, model: string, pending: boolean): void;
  recordSessionEffortOnSend(sessionId: string, effort: string, pending: boolean): void;
  applySessionConfigReport(sessionId: string, report: ProviderSessionConfigReport): boolean;
};

/** SQLite catalog operations used by the Providers service and its unit fakes. */
type ProviderModelsCatalogStore = Pick<
  typeof providerModelsDb,
  | 'listCustomProviderModels'
  | 'getCustomProviderModel'
  | 'findCustomProviderModelByModelId'
  | 'createCustomProviderModel'
  | 'updateCustomProviderModel'
  | 'deleteCustomProviderModel'
>;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  catalog?: ProviderModelsCatalogStore;
  sessions?: ProviderModelsSessionStore;
};

const toCustomProviderModelOption = (
  record: CustomProviderModelRecord,
): ProviderModelOption => ({
  value: record.modelId,
  label: record.model,
  recordId: record.recordId,
  isCustom: true,
});

const mergeProviderModels = (
  predefined: ProviderModelsDefinition,
  custom: CustomProviderModelRecord[],
): ProviderModelsDefinition => {
  return {
    OPTIONS: [
      ...predefined.OPTIONS.map((option) => ({ ...option, isCustom: false })),
      ...custom.map(toCustomProviderModelOption),
    ],
    DEFAULT: predefined.DEFAULT,
  };
};

const normalizeCustomModelInput = (input: CustomProviderModelInput): CustomProviderModelInput => ({
  id: input.id.trim(),
  model: input.model.trim(),
});

const isUniqueConstraintError = (error: unknown): boolean => (
  error !== null
  && error !== undefined
  && typeof error === 'object'
  && 'code' in error
  && String(error.code).startsWith('SQLITE_CONSTRAINT')
);

/**
 * Creates the provider model application service used by Providers routes,
 * Commands, and provider runtimes.
 *
 * Curated adapter definitions stay source-controlled and are merged at read
 * time with custom SQLite rows. This deliberately has no predefined-model
 * persistence, memory cache, disk cache, TTL, or provider-native discovery.
 * Tests inject a small custom-model store through the same boundary.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const catalog = dependencies.catalog ?? providerModelsDb;
  const sessions = dependencies.sessions ?? sessionsDb;

  const getProviderModels = async (provider: LLMProvider): Promise<ProviderModelsDefinition> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    return mergeProviderModels(predefined, catalog.listCustomProviderModels(provider));
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const readCustomModel = (
    provider: LLMProvider,
    recordId: number,
  ): CustomProviderModelRecord => {
    const existing = catalog.getCustomProviderModel(provider, recordId);
    if (!existing) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return existing;
  };

  const assertModelIdAvailable = (
    provider: LLMProvider,
    predefined: ProviderModelsDefinition,
    modelId: string,
    currentRecordId?: number,
  ): void => {
    if (predefined.OPTIONS.some((option) => option.value === modelId)) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }

    const duplicate = catalog.findCustomProviderModelByModelId(provider, modelId);
    if (duplicate && duplicate.recordId !== currentRecordId) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }
  };

  const createCustomModel = async (
    provider: LLMProvider,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id);

    try {
      const created = catalog.createCustomProviderModel(provider, normalized);
      return {
        model: toCustomProviderModelOption(created),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const updateCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    readCustomModel(provider, recordId);
    const normalized = normalizeCustomModelInput(input);
    assertModelIdAvailable(provider, predefined, normalized.id, recordId);

    try {
      const updated = catalog.updateCustomProviderModel(provider, recordId, normalized);
      if (!updated) {
        throw new AppError('Model not found.', {
          code: 'MODEL_NOT_FOUND',
          statusCode: 404,
        });
      }

      return {
        model: toCustomProviderModelOption(updated),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const deleteCustomModel = async (
    provider: LLMProvider,
    recordId: number,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    readCustomModel(provider, recordId);
    const removed = catalog.deleteCustomProviderModel(provider, recordId, predefined.DEFAULT);
    if (!removed) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      model: toCustomProviderModelOption(removed),
      models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
    };
  };

  const readRecordedSessionSelection = (
    sessionId: string,
  ): ProviderSessionSelectionSnapshot | null => {
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
      liveModel: session.live_model?.trim() || null,
      liveEffort: session.live_effort?.trim() || null,
      modelDirty: session.model_dirty === 1,
      effortDirty: session.effort_dirty === 1,
    };
  };

  /**
   * Records an explicit model choice for one session.
   *
   * OMP concrete models remain dirty until OMP reports the same value. Its
   * configured-model sentinel is app-only and therefore has nothing for OMP
   * to acknowledge.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
    if (!recordedSelection) {
      return null;
    }

    const modelDirty = provider === 'omp' && normalizedModel !== OMP_CONFIGURED_MODEL_SENTINEL;
    sessions.setSessionModel(normalizedSessionId, normalizedModel, modelDirty);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      effort: recordedSelection.effort,
      liveModel: null,
      liveEffort: recordedSelection.liveEffort,
      modelDirty,
      effortDirty: recordedSelection.effortDirty,
      source: 'session',
    };
  };

  /** Records an explicit effort choice with the same OMP acknowledgement rule. */
  const setSessionEffort = (
    provider: LLMProvider,
    sessionId: string,
    effort: string,
  ): (Pick<ProviderSessionModel, 'provider' | 'sessionId' | 'effort' | 'liveEffort' | 'effortDirty' | 'source'>) | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedEffort = effort.trim();
    if (!normalizedSessionId || !normalizedEffort) {
      return null;
    }

    if (!readRecordedSessionSelection(normalizedSessionId)) {
      return null;
    }

    const effortDirty = provider === 'omp' && normalizedEffort !== 'default';
    sessions.setSessionEffort(normalizedSessionId, normalizedEffort, effortDirty);
    return {
      provider,
      sessionId: normalizedSessionId,
      effort: normalizedEffort,
      liveEffort: null,
      effortDirty,
      source: 'session',
    };
  };

  /**
   * Records the composer's repeated send values without turning provider echoes
   * into new explicit choices.
   */
  const recordSessionSelectionOnSend = (
    provider: LLMProvider,
    sessionId: string,
    selection: { model?: string | null; effort?: string | null },
  ): void => {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) {
      return;
    }
    const model = typeof selection.model === 'string' ? selection.model.trim() : '';
    const effort = typeof selection.effort === 'string' ? selection.effort.trim() : '';
    if (model) {
      sessions.recordSessionModelOnSend(
        normalizedSessionId,
        model,
        provider === 'omp' && model !== OMP_CONFIGURED_MODEL_SENTINEL,
      );
    }
    if (effort) {
      sessions.recordSessionEffortOnSend(
        normalizedSessionId,
        effort,
        provider === 'omp' && effort !== 'default',
      );
    }
  };

  /** Returns only choices that still require a provider acknowledgement. */
  const readPendingSessionSelection = (sessionId: string): PendingProviderSessionSelection => {
    const selection = readRecordedSessionSelection(sessionId.trim());
    const model = selection?.modelDirty && selection.model
      ? { pending: true as const, value: selection.model }
      : { pending: false as const, value: selection?.model ?? null };
    const effort = selection?.effortDirty && selection.effort
      ? { pending: true as const, value: selection.effort }
      : { pending: false as const, value: selection?.effort ?? null };
    return { sessionExists: selection !== null, model, effort };
  };

  /**
   * Applies one provider report to the mapped session and returns the app id
   * when the stored selection changed.
   */
  const recordProviderSessionConfig = (
    provider: LLMProvider,
    appSessionId: string | null | undefined,
    providerSessionId: string,
    report: ProviderSessionConfigReport,
  ): string | null => {
    const row = (appSessionId ? sessions.getSessionById(appSessionId) : null)
      ?? sessions.getSessionByProviderSessionId(providerSessionId);
    if (!row || row.provider !== provider) {
      return null;
    }
    return sessions.applySessionConfigReport(row.session_id, report) ? row.session_id : null;
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * The persisted pin remains in `model`, while `liveModel` and `liveEffort`
   * carry confirmed provider state. A pending choice has no live value because
   * the write retires the preceding report.
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recorded = readRecordedSessionSelection(normalizedSessionId);
      if (recorded?.model) {
        return {
          provider,
          sessionId: normalizedSessionId,
          ...recorded,
          model: recorded.model,
          source: 'session',
        };
      }
      if (recorded?.liveModel) {
        return {
          provider,
          sessionId: normalizedSessionId,
          ...recorded,
          model: recorded.liveModel,
          source: 'provider',
        };
      }

      const providerCatalog = await getProviderModels(provider);
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== providerCatalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          effort: recorded?.effort ?? null,
          liveModel: resolvedProviderModel,
          liveEffort: recorded?.liveEffort ?? null,
          modelDirty: false,
          effortDirty: recorded?.effortDirty ?? false,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || providerCatalog.DEFAULT,
        effort: recorded?.effort ?? null,
        liveModel: null,
        liveEffort: recorded?.liveEffort ?? null,
        modelDirty: false,
        effortDirty: recorded?.effortDirty ?? false,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        effort: null,
        liveModel: null,
        liveEffort: null,
        modelDirty: false,
        effortDirty: false,
        source: 'session',
      };
    }

    const providerCatalog = await getProviderModels(provider);
    return {
      provider,
      sessionId: null,
      model: providerCatalog.DEFAULT,
      effort: null,
      liveModel: null,
      liveEffort: null,
      modelDirty: false,
      effortDirty: false,
      source: 'default',
    };
  };

  /**
   * Picks the model one resumed provider run should use.
   *
   * Provider-global state is deliberately ignored because it must never
   * override the model explicitly selected in the composer.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionSelection(normalizedSessionId)?.model;
    return recordedModel || normalizedRequestedModel || undefined;
  };

  return {
    getProviderModels,
    createCustomModel,
    updateCustomModel,
    deleteCustomModel,
    setSessionModel,
    setSessionEffort,
    recordSessionSelectionOnSend,
    readPendingSessionSelection,
    recordProviderSessionConfig,
    resolveSessionModel,
    resolveResumeModel,
  };
};

/** Shared Providers service used by routes, Commands, and provider runtimes. */
export const providerModelsService = createProviderModelsService();
