import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  LLMProvider,
  PendingProviderSessionSelection,
  ProviderPermissionDecision,
  ProviderRunFunction,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
  ProviderSessionConfigReport,
} from '@/shared/types.js';

type ProviderRuntimeServiceDependencies = {
  listProviders(): IProvider[];
  resolveProvider(provider: string): IProvider;
  resolveProviderSessionId(sessionId: string | null | undefined): string | null;
  resolveResumeModel(
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined>;
  getProviderModels: typeof providerModelsService.getProviderModels;
  readPendingSessionSelection(sessionId: string): PendingProviderSessionSelection;
  recordProviderSessionConfig(
    provider: LLMProvider,
    appSessionId: string | null | undefined,
    providerSessionId: string,
    report: ProviderSessionConfigReport,
  ): string | null;
  broadcastSessionUpserted(sessionId: string): Promise<void>;
};

const defaultDependencies: ProviderRuntimeServiceDependencies = {
  listProviders: () => providerRegistry.listProviders(),
  resolveProvider: (provider) => providerRegistry.resolveProvider(provider),
  resolveProviderSessionId: (sessionId) => sessionsService.resolveProviderSessionId(sessionId),
  resolveResumeModel: (provider, sessionId, requestedModel) =>
    providerModelsService.resolveResumeModel(provider, sessionId, requestedModel),
  getProviderModels: (provider) => providerModelsService.getProviderModels(provider),
  readPendingSessionSelection: (sessionId) =>
    providerModelsService.readPendingSessionSelection(sessionId),
  recordProviderSessionConfig: (provider, appSessionId, providerSessionId, report) =>
    providerModelsService.recordProviderSessionConfig(
      provider,
      appSessionId,
      providerSessionId,
      report,
    ),
  broadcastSessionUpserted,
};

/**
 * Creates the application-facing provider runtime dispatcher.
 *
 * The provider registry owns each concrete runtime. This service supplies the
 * registry-backed model/session lookups at execution time so runtime adapters
 * never import services that resolve back through the registry.
 */
export function createProviderRuntimeService(
  dependencyOverrides: Partial<ProviderRuntimeServiceDependencies> = {},
) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const getPermissionOwner = () => {
    // Permission-capable runtimes expose the same process-wide approval
    // registry. Route through one gateway so adding another runtime cannot
    // replay or resolve every pending row once per registered provider.
    for (const provider of dependencies.listProviders()) {
      if (provider.runtime.permissions) {
        return provider.runtime.permissions;
      }
    }
    return undefined;
  };

  const createRuntimeContext = (
    provider: IProvider,
  ): ProviderRuntimeContext => ({
    resolveProviderSessionId: dependencies.resolveProviderSessionId,
    resolveResumeModel: (sessionId, requestedModel) =>
      dependencies.resolveResumeModel(provider.id, sessionId, requestedModel),
    getProviderModels: async () => dependencies.getProviderModels(provider.id),
    normalizeMessage: (raw, sessionId) => provider.sessions.normalizeMessage(raw, sessionId),
    readPendingSessionSelection: (sessionId) =>
      dependencies.readPendingSessionSelection(sessionId ?? ''),
    async recordSessionConfigReport(appSessionId, providerSessionId, report) {
      const changedSessionId = dependencies.recordProviderSessionConfig(
        provider.id,
        appSessionId,
        providerSessionId,
        report,
      );
      if (changedSessionId) {
        await dependencies.broadcastSessionUpserted(changedSessionId);
      }
    },
    async isProviderInstalled() {
      try {
        return (await provider.auth.getStatus()).installed;
      } catch {
        // Preserve the runtime's original error when installation probing fails.
        return true;
      }
    },
  });

  const run = (
    providerName: LLMProvider,
    command: string,
    options: AnyRecord,
    writer: ProviderRuntimeWriter,
  ): Promise<unknown> => {
    const provider = dependencies.resolveProvider(providerName);
    return provider.runtime.run(command, options, writer, createRuntimeContext(provider));
  };

  return {
    run,

    hasRuntime(providerName: string): boolean {
      try {
        return Boolean(dependencies.resolveProvider(providerName).runtime);
      } catch {
        return false;
      }
    },

    getRunner(provider: LLMProvider): ProviderRunFunction {
      return (command, options, writer) => run(provider, command, options, writer);
    },

    async abort(providerName: LLMProvider, sessionId: string): Promise<boolean> {
      return Boolean(await dependencies.resolveProvider(providerName).runtime.abort(sessionId));
    },

    resolveToolApproval(requestId: string, decision: ProviderPermissionDecision): void {
      getPermissionOwner()?.resolve(requestId, decision);
    },

    getPendingApprovalsForSession(sessionId: string): unknown[] {
      return getPermissionOwner()?.listPending(sessionId) ?? [];
    },
  };
}

export const providerRuntimeService = createProviderRuntimeService();
