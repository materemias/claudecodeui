import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { usePlugins } from '@/modules/plugins';
import { LLMProviderLogo } from '@/shared/ui';
import { api, readApiJson } from '@/shared/api';
import type { AppTab, Project, ProjectSession } from '@/shared/types';
import { cn, copyTextToClipboard, getSessionTitle } from '@/shared/utils';

type WorkspaceTitleProps = {
  activeTab: AppTab;
  selectedProject: Project;
  selectedSession: ProjectSession | null;
  shouldShowTasksTab: boolean;
};

type CopyResumeCommandState = 'idle' | 'copying' | 'copied' | 'error';

type CopyResumeCommandButtonProps = {
  sessionId: string;
};

function CopyResumeCommandButton({ sessionId }: CopyResumeCommandButtonProps) {
  const { t } = useTranslation();
  const activeRequestRef = useRef<AbortController | null>(null);
  // Tracks the request and clipboard result so the icon and accessible label
  // provide immediate feedback without adding a global notification dependency.
  const [copyState, setCopyState] = useState<CopyResumeCommandState>('idle');

  useEffect(() => () => {
    activeRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    if (copyState === 'idle' || copyState === 'copying') {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopyState('idle'), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  const handleCopy = async () => {
    if (copyState === 'copying') {
      return;
    }

    const request = new AbortController();
    activeRequestRef.current = request;
    setCopyState('copying');
    try {
      const response = await api.sessionResumeCommand(sessionId, { signal: request.signal });
      const payload = await readApiJson<{ data?: { command?: unknown } }>(response);
      if (request.signal.aborted) {
        return;
      }

      const command = payload.data?.command;
      if (typeof command !== 'string' || !command) {
        throw new Error('Resume command is unavailable.');
      }

      if (!(await copyTextToClipboard(command)) || request.signal.aborted) {
        throw new Error('Clipboard write failed.');
      }
      setCopyState('copied');
    } catch (error) {
      if (request.signal.aborted) {
        return;
      }
      console.error('Failed to copy session resume command:', error);
      setCopyState('error');
    } finally {
      if (activeRequestRef.current === request) {
        activeRequestRef.current = null;
      }
    }
  };

  let label = t('mainContent.copyResumeCommand', { defaultValue: 'Copy resume command' });
  if (copyState === 'copied') {
    label = t('mainContent.resumeCommandCopied', { defaultValue: 'Resume command copied' });
  } else if (copyState === 'error') {
    label = t('mainContent.resumeCommandFailed', { defaultValue: 'Could not copy resume command' });
  } else if (copyState === 'copying') {
    label = t('mainContent.resumeCommandPreparing', { defaultValue: 'Preparing resume command' });
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      disabled={copyState === 'copying'}
      aria-label={label}
      title={label}
      className={cn(
        'hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:cursor-wait disabled:opacity-60 sm:flex',
        copyState === 'copied' && 'text-emerald-600 dark:text-emerald-400',
        copyState === 'error' && 'text-destructive',
      )}
    >
      {copyState === 'copied' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function getTabTitle(activeTab: AppTab, shouldShowTasksTab: boolean, t: (key: string) => string, pluginDisplayName?: string) {
  if (activeTab.startsWith('plugin:') && pluginDisplayName) {
    return pluginDisplayName;
  }

  if (activeTab === 'files') {
    return t('mainContent.projectFiles');
  }

  if (activeTab === 'git') {
    return t('tabs.git');
  }

  if (activeTab === 'tasks' && shouldShowTasksTab) {
    return 'TaskMaster';
  }

  if (activeTab === 'browser') {
    return t('tabs.browser');
  }

  return 'Project';
}

/** Rendered by WorkspaceHeader to label the workspace with the active session or tab name. */
export default function WorkspaceTitle({
  activeTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
}: WorkspaceTitleProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();

  const pluginDisplayName = activeTab.startsWith('plugin:')
    ? plugins.find((p) => p.name === activeTab.replace('plugin:', ''))?.displayName
    : undefined;

  const showSessionIcon = activeTab === 'chat' && Boolean(selectedSession);
  const showChatNewSession = activeTab === 'chat' && !selectedSession;

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      {showSessionIcon && (
        <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <LLMProviderLogo provider={selectedSession?.__provider} className="h-4 w-4" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        {activeTab === 'chat' && selectedSession ? (
          <div className="min-w-0">
            <h2 title={getSessionTitle(selectedSession)} className="truncate text-sm font-semibold leading-tight text-foreground">
              {getSessionTitle(selectedSession)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : showChatNewSession ? (
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-tight text-foreground">{t('mainContent.newSession')}</h2>
            <div className="truncate text-xs leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        ) : (
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight text-foreground">
              {getTabTitle(activeTab, shouldShowTasksTab, t, pluginDisplayName)}
            </h2>
            <div className="truncate text-[11px] leading-tight text-muted-foreground">{selectedProject.displayName}</div>
          </div>
        )}
      </div>
      {activeTab === 'chat' && selectedSession && (
        <CopyResumeCommandButton key={selectedSession.id} sessionId={selectedSession.id} />
      )}
    </div>
  );
}
